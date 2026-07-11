import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Builds the closed-loan leaderboard from GoHighLevel and writes an aggregated
 * docs/leaderboard.json for the rotating display board (docs/index.html).
 *
 * "Closed" = an opportunity in the Loan Pipeline currently in the Closed OR
 * Wire Received stage, whose most recent stage change happened in the target
 * year. For each rep we emit three metrics over two windows (this year / this
 * month):
 *   - value      → sum of opportunity monetaryValue (KREC deal value)
 *   - loanAmount → sum of the "Loan Amount" custom field (loan principal)
 *   - loans      → count of closed loans
 * Output contains ONLY aggregated per-rep numbers (no contact PII), so it is
 * safe to publish on public GitHub Pages.
 */

const TOKEN = process.env.GHL_API_TOKEN || "";
const LOCATION = process.env.GHL_LOCATION_ID || "dJyVhiOEL3jUzPECFhIe";
const YEAR = Number(process.env.LEADERBOARD_YEAR) || new Date().getFullYear();
/**
 * Public-deploy mode (set in CI): strips borrower/deal names from the published
 * JSON so the public site shows only rep + amount + loan type. Local runs keep
 * the names for the in-office TV view.
 */
const PUBLIC_MODE = !!process.env.LEADERBOARD_PUBLIC;

const API = "https://services.leadconnectorhq.com";
const LOAN_PIPELINE = "IsrgP5crefloPlF9MGnf";
const CLOSED_STAGES = new Set([
  "72464bb2-1a05-489e-bcf9-eb2989e3468c", // Closed
  "935a63c3-e50a-473c-a663-e52f33224c55", // Wire Received
]);
const LOAN_AMOUNT_FIELD = "jtXkBiL3K4ysBhfZHbct"; // "Loan Amount" custom field (principal)
const DETAIL_CONCURRENCY = 5;
const STAGE_LABEL: Record<string, string> = {
  "72464bb2-1a05-489e-bcf9-eb2989e3468c": "Closed",
  "935a63c3-e50a-473c-a663-e52f33224c55": "Wire Received",
};
/** Funded deals from the last N days feed the "Just Funded" ticker. */
const RECENT_DAYS = 7;

const headers = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKOFFS = [1000, 3000, 8000, 20000];

async function api(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { headers });
    } catch (err) {
      if (attempt >= BACKOFFS.length) throw err;
      await sleep(BACKOFFS[attempt]);
      continue;
    }
    if (resp.ok) return resp.json();
    const body = await resp.text();
    const transient = resp.status === 429 || resp.status >= 500 || /try again later|failed to fetch|timed out/i.test(body);
    if (transient && attempt < BACKOFFS.length) {
      await sleep(BACKOFFS[attempt]);
      continue;
    }
    throw new Error(`GHL ${url}: ${resp.status} ${body.slice(0, 120)}`);
  }
}

async function userNames(): Promise<Record<string, string>> {
  const data = await api(`${API}/users/?locationId=${LOCATION}`);
  const map: Record<string, string> = {};
  for (const u of data.users || []) map[u.id] = u.name || `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim();
  return map;
}

/** Resolve the "Loan Type" opportunity custom-field id (for deal flavor text). */
async function loanTypeFieldId(): Promise<string> {
  try {
    const data = await api(`${API}/locations/${LOCATION}/customFields?model=opportunity`);
    const f = (data.customFields || []).find((c: any) => c.name === "Loan Type");
    return f?.id || "";
  } catch {
    return "";
  }
}

interface Opp {
  id: string;
  name?: string;
  monetaryValue?: number;
  pipelineStageId?: string;
  assignedTo?: string | null;
  followers?: string[];
  lastStageChangeAt?: string;
  updatedAt?: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Loan principal + loan type from the opportunity's custom fields (detail GET). */
async function detailFor(oppId: string, loanTypeId: string): Promise<{ loanAmount: number; loanType: string }> {
  const data = await api(`${API}/opportunities/${oppId}`);
  const opp = data.opportunity || data;
  const cfs: any[] = opp.customFields || [];
  const read = (id: string) => {
    const e = cfs.find((c) => c.id === id);
    return e ? (e.fieldValue ?? e.value) : undefined;
  };
  const n = Number(read(LOAN_AMOUNT_FIELD));
  const lt = loanTypeId ? read(loanTypeId) : undefined;
  return { loanAmount: Number.isFinite(n) ? n : 0, loanType: typeof lt === "string" ? lt : Array.isArray(lt) ? lt.join(", ") : "" };
}

async function allClosedOpps(): Promise<Opp[]> {
  const out: Opp[] = [];
  let startAfter: string | null = null;
  let startAfterId: string | null = null;
  for (let page = 1; ; page++) {
    const u = new URL(`${API}/opportunities/search`);
    u.searchParams.set("location_id", LOCATION);
    u.searchParams.set("pipeline_id", LOAN_PIPELINE);
    u.searchParams.set("limit", "100");
    if (startAfter && startAfterId) {
      u.searchParams.set("startAfter", startAfter);
      u.searchParams.set("startAfterId", startAfterId);
    }
    const data = await api(u.toString());
    const opps: Opp[] = data.opportunities || [];
    if (!opps.length) break;
    out.push(...opps);
    const meta = data.meta || {};
    if (!meta.nextPage || !meta.startAfterId) break;
    startAfter = String(meta.startAfter);
    startAfterId = meta.startAfterId;
    await sleep(120);
  }
  return out;
}

function closedThisYear(o: Opp): boolean {
  if (!o.pipelineStageId || !CLOSED_STAGES.has(o.pipelineStageId)) return false;
  const when = o.lastStageChangeAt || o.updatedAt || "";
  return when.startsWith(String(YEAR));
}

interface Bucket {
  loanAmount: number;
  loans: number;
}
const mkBucket = (): Bucket => ({ loanAmount: 0, loans: 0 });

async function main() {
  if (!TOKEN) throw new Error("GHL_API_TOKEN is not set.");
  const now = new Date();
  const monthPrefix = `${YEAR}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const [names, loanTypeId, opps] = await Promise.all([userNames(), loanTypeFieldId(), allClosedOpps()]);
  const closed = opps.filter(closedThisYear);
  const details = await mapLimit(closed, DETAIL_CONCURRENCY, (o) => detailFor(o.id, loanTypeId));

  const repNameOf = (id?: string | null) => (!id ? "Unassigned" : names[id] || `(user ${id.slice(0, 6)})`);

  const reps = new Map<string, { year: Bucket; month: Bucket }>();
  // Processors = users added as followers on the opportunity; credited by loan count.
  const processors = new Map<string, { year: Bucket; month: Bucket }>();
  const credit = (map: Map<string, { year: Bucket; month: Bucket }>, key: string, la: number, inMonth: boolean) => {
    const rec = map.get(key) || { year: mkBucket(), month: mkBucket() };
    rec.year.loanAmount += la;
    rec.year.loans += 1;
    if (inMonth) {
      rec.month.loanAmount += la;
      rec.month.loans += 1;
    }
    map.set(key, rec);
  };
  closed.forEach((o, i) => {
    const la = details[i]?.loanAmount || 0;
    const inMonth = (o.lastStageChangeAt || o.updatedAt || "").startsWith(monthPrefix);
    credit(reps, o.assignedTo || "__unassigned__", la, inMonth);
    for (const f of new Set(o.followers || [])) credit(processors, f, la, inMonth);
  });

  // Deals closed in the last RECENT_DAYS for the "Just Funded" ticker. NO borrower
  // PII and NO commission/value — only rep, loan amount, loan type, stage, time.
  const cutoff = Date.now() - RECENT_DAYS * 86400_000;
  const latest = closed
    .map((o, i) => ({
      id: o.id,
      name: PUBLIC_MODE ? "" : o.name || "",
      rep: repNameOf(o.assignedTo),
      loanAmount: Math.round(details[i]?.loanAmount || 0),
      loanType: details[i]?.loanType || "",
      stage: STAGE_LABEL[o.pipelineStageId || ""] || "Closed",
      closedAt: o.lastStageChangeAt || o.updatedAt || "",
    }))
    .filter((d) => d.closedAt && new Date(d.closedAt).getTime() >= cutoff)
    .sort((a, b) => (a.closedAt < b.closedAt ? 1 : -1));

  const round = (b: Bucket): Bucket => ({ loanAmount: Math.round(b.loanAmount), loans: b.loans });
  const toArr = (map: Map<string, { year: Bucket; month: Bucket }>) =>
    [...map.entries()].map(([id, v]) => ({
      name: id === "__unassigned__" ? "Unassigned" : names[id] || `(user ${id.slice(0, 6)})`,
      year: round(v.year),
      month: round(v.month),
    }));
  /** Names hidden from the public board (owner/system buckets, not sales staff). */
  const EXCLUDED_NAMES = new Set(["Keyan Chang", "Unassigned"]);
  const repArr = toArr(reps).filter((r) => !EXCLUDED_NAMES.has(r.name));
  const processorArr = toArr(processors).filter((p) => !EXCLUDED_NAMES.has(p.name));
  for (const l of latest) if (EXCLUDED_NAMES.has(l.rep)) l.rep = "KREC";

  const payload = {
    updatedAt: new Date().toISOString(),
    year: YEAR,
    monthLabel: now.toLocaleString("en-US", { month: "long", year: "numeric" }),
    monthPrefix,
    definition: "Loan Pipeline opportunities in Closed or Wire Received stage. loanAmount = 'Loan Amount' custom field (principal); loans = count. AEs = assignedTo; processors = opportunity followers. (Commission/value intentionally excluded.)",
    reps: repArr,
    processors: processorArr,
    latest,
  };

  const outDir = fileURLToPath(new URL("../docs", import.meta.url));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/leaderboard.json`, JSON.stringify(payload, null, 2) + "\n");

  const yTotal = repArr.reduce((s, r) => s + r.year.loanAmount, 0);
  const yLoans = repArr.reduce((s, r) => s + r.year.loans, 0);
  const mLoans = repArr.reduce((s, r) => s + r.month.loans, 0);
  console.log(`Wrote leaderboard.json: ${repArr.length} reps | YTD ${yLoans} loans / $${yTotal.toLocaleString()} | ${payload.monthLabel}: ${mLoans} loans.`);
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
