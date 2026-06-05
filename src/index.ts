import { DISTRIBUTION, ELEMENTIX, GHL, TAGS } from "./config.js";
import { Allocator, computeRepLoad, demand, RepLoad } from "./distribute.js";
import { ensureUnlockedContact, ElementixPerson, listPeople } from "./elementix.js";
import { addContactToWorkflow, findContactByEmailOrPhone, upsertContact } from "./ghl.js";
import { log } from "./logger.js";
import { activeReps, loadRoster } from "./roster.js";

interface Args {
  dryRun: boolean;
  reportOnly: boolean;
  limit?: number;
  state?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, reportOnly: false };
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--report-only") args.reportOnly = true;
    else if (a.startsWith("--limit=")) args.limit = Number(a.split("=")[1]);
    else if (a.startsWith("--state=")) args.state = a.split("=")[1].toUpperCase();
  }
  return args;
}

function leadState(p: ElementixPerson): string | undefined {
  return (p.state || "").toUpperCase() || undefined;
}

function leadName(p: ElementixPerson): { firstName?: string; lastName?: string; name?: string } {
  if (p.firstName || p.lastName) return { firstName: p.firstName, lastName: p.lastName };
  return { name: p.name };
}

function printLoadReport(loads: RepLoad[]): void {
  log.step("Current rep load (active = non-exhausted leads)");
  const rows = [...loads].sort((a, b) => a.active - b.active);
  for (const l of rows) {
    log.info(
      `${l.rep.role.padEnd(3)} ${l.rep.name.padEnd(24)} ` +
        `active=${String(l.active).padStart(4)} / cap ${String(l.rep.capacity).padStart(4)} | ` +
        `exhausted=${String(l.exhausted).padStart(4)} (opted-out ${l.optedOut}) | ` +
        `headroom=${l.headroom}`,
    );
  }
  const totalActive = loads.reduce((s, l) => s + l.active, 0);
  const totalHeadroom = loads.reduce((s, l) => s + l.headroom, 0);
  log.info(`TOTAL active=${totalActive} headroom=${totalHeadroom}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!GHL.token) {
    log.error("GHL_API_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  log.step(`KREC lead distributor — ${args.dryRun ? "DRY RUN" : args.reportOnly ? "REPORT ONLY" : "LIVE"}`);

  // 1. Roster
  const reps = activeReps(loadRoster());
  if (reps.length === 0) {
    log.error("No active reps in config/roster.json.");
    process.exit(1);
  }
  log.info(`Loaded ${reps.length} active rep(s) from roster.`);

  // 2. Current load per rep
  log.step("Measuring current load (this counts touchpoints per assigned contact)…");
  const loads: RepLoad[] = [];
  for (const rep of reps) {
    const load = await computeRepLoad(rep);
    loads.push(load);
    log.info(`  ${rep.name}: ${load.active} active / ${load.total} total (${load.headroom} headroom)`);
  }
  printLoadReport(loads);

  if (args.reportOnly) {
    log.step("Report only — no leads pulled or assigned.");
    return;
  }

  // 3. How many leads to pull this run
  let need = demand(loads);
  if (args.limit != null) need = Math.min(need, args.limit);
  if (need <= 0) {
    log.step("Every rep is at capacity — nothing to distribute. Done.");
    return;
  }
  log.step(`Targeting ${need} new lead(s) this run (maxPerRun=${DISTRIBUTION.maxPerRun}).`);

  if (!ELEMENTIX.bearerToken) {
    log.error("ELEMENTIX_BEARER_TOKEN is not set — cannot pull leads. Authorize Elementix and set the token.");
    process.exit(1);
  }

  // 4. Pull cold leads from Elementix. Pull a buffer above `need` to absorb
  //    dedupe drops and territory mismatches.
  log.step("Pulling cold leads from Elementix…");
  const people = await listPeople({
    state: args.state,
    isBusinessPurpose: true,
    limit: Math.ceil(need * 1.5) + 10,
  });
  log.info(`Elementix returned ${people.length} candidate lead(s).`);

  // 5. Balance + assign
  const allocator = new Allocator(loads);
  const created: Array<{ name: string; rep: string }> = [];
  let placed = 0;
  let skippedExisting = 0;
  let skippedNoRep = 0;

  for (const person of people) {
    if (placed >= need) break;

    const nm = leadName(person);
    const display = nm.name || `${nm.firstName ?? ""} ${nm.lastName ?? ""}`.trim() || person.uuid;

    if (args.dryRun) {
      // Dry run can't unlock/dedupe (that costs credits), so reserve optimistically.
      const rep = allocator.pick(leadState(person));
      if (!rep) {
        skippedNoRep++;
        continue;
      }
      created.push({ name: display, rep: rep.name });
      placed++;
      continue;
    }

    // Live: unlock contact info and dedupe BEFORE reserving a rep slot, so skipped
    // leads never consume a rep's headroom or inflate the summary counts.
    let contact: { phone?: string; email?: string } = {};
    try {
      contact = await ensureUnlockedContact(person.uuid);
    } catch (err: any) {
      log.warn(`  unlock failed for ${display}: ${err.message}`);
      continue;
    }

    if (!contact.email && !contact.phone) {
      log.warn(`  no contact info for ${display} — skipping.`);
      continue;
    }

    const existing = await findContactByEmailOrPhone(contact.email, contact.phone);
    if (existing) {
      skippedExisting++;
      log.info(`  ${display} already exists (owner ${existing.assignedTo ?? "unassigned"}) — skipping.`);
      continue;
    }

    // Lead is real and new — now reserve the best rep for it.
    const rep = allocator.pick(leadState(person));
    if (!rep) {
      skippedNoRep++;
      continue; // no rep with headroom (and matching territory)
    }

    const { contact: newContact } = await upsertContact({
      ...nm,
      email: contact.email,
      phone: contact.phone,
      state: person.state,
      city: person.city,
      postalCode: person.zip,
      source: TAGS.source,
      assignedTo: rep.ghlUserId,
      tags: [TAGS.source, TAGS.coldLead],
    });

    if (GHL.enrollWorkflowId) {
      try {
        await addContactToWorkflow(newContact.id, GHL.enrollWorkflowId);
      } catch (err: any) {
        log.warn(`  workflow enroll failed for ${display}: ${err.message}`);
      }
    }

    created.push({ name: display, rep: rep.name });
    placed++;
    log.info(`  → assigned ${display} to ${rep.name}`);
  }

  // 6. Summary
  log.step("Distribution summary");
  for (const { rep, count } of allocator.assignmentCounts()) {
    if (count > 0) log.info(`  ${rep.name}: +${count} lead(s)`);
  }
  log.info(
    `Placed ${placed} lead(s)${args.dryRun ? " (dry run — none written)" : ""}. ` +
      `Skipped: ${skippedExisting} existing, ${skippedNoRep} no-rep.`,
  );
}

main().catch((err) => {
  log.error(err?.stack || String(err));
  process.exit(1);
});
