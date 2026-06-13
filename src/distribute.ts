import { DISTRIBUTION } from "./config.js";
import { GHLContact, searchContactsByAssignedTo } from "./ghl.js";
import { log } from "./logger.js";
import { Rep } from "./roster.js";
import { Classification, classifyContact } from "./touchpoints.js";

export interface RepLoad {
  rep: Rep;
  total: number;
  active: number;
  exhausted: number;
  optedOut: number;
  /** Room for new leads before hitting capacity. */
  headroom: number;
  /** The actual contacts classified as exhausted, for downstream tagging. */
  exhaustedContacts: GHLContact[];
}

/** Run an async mapper over items with bounded concurrency. */
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

/**
 * Compute a rep's current load: how many of their assigned contacts are still
 * "active" (not exhausted) versus exhausted/opted-out. `active` is what the
 * balancer equalizes; `headroom` is capacity minus active.
 */
export async function computeRepLoad(rep: Rep): Promise<RepLoad> {
  const contacts = await searchContactsByAssignedTo(rep.ghlUserId);
  // A single contact whose classification fails (after retries) must not abort
  // the whole run. Treat it as non-exhausted (safer to under-tag than mis-tag)
  // and keep going, leaving a breadcrumb in the log.
  const classes = await mapLimit(contacts, DISTRIBUTION.classifyConcurrency, async (c): Promise<Classification> => {
    try {
      return await classifyContact(c);
    } catch (err: any) {
      log.warn(`  classify failed for ${rep.name} contact ${c.id}: ${err.message} — treating as non-exhausted`);
      return { contactId: c.id, touchpoints: 0, optedOut: false, exhausted: false };
    }
  });

  let exhausted = 0;
  let optedOut = 0;
  const exhaustedContacts: GHLContact[] = [];
  for (let i = 0; i < classes.length; i++) {
    const c = classes[i];
    if (c.optedOut) optedOut++;
    if (c.exhausted) {
      exhausted++;
      exhaustedContacts.push(contacts[i]);
    }
  }
  const total = contacts.length;
  const active = total - exhausted;
  return {
    rep,
    total,
    active,
    exhausted,
    optedOut,
    headroom: Math.max(0, rep.capacity - active),
    exhaustedContacts,
  };
}

/**
 * Stateful allocator that hands out reps for incoming leads, equalizing
 * projected active load while respecting per-rep capacity and (optional)
 * territory. Reps that declare `states` only receive leads in those states;
 * reps with no declared states act as wildcards.
 */
export class Allocator {
  private projected = new Map<string, number>();
  private assigned = new Map<string, number>();

  constructor(private loads: RepLoad[]) {
    for (const l of loads) {
      this.projected.set(l.rep.ghlUserId, l.active);
      this.assigned.set(l.rep.ghlUserId, 0);
    }
  }

  /** Total leads that can still be placed across all reps. */
  get totalHeadroom(): number {
    return this.loads.reduce(
      (sum, l) => sum + Math.max(0, l.rep.capacity - (this.projected.get(l.rep.ghlUserId) ?? 0)),
      0,
    );
  }

  /**
   * Pick the best rep for a lead in `leadState` (2-letter code, optional):
   * the eligible rep with the lowest projected load that still has headroom.
   * Returns null if no rep can take it. Mutates internal counters on success.
   */
  pick(leadState?: string): Rep | null {
    const st = leadState?.toUpperCase();
    let best: RepLoad | null = null;
    let bestProjected = Infinity;
    for (const l of this.loads) {
      const id = l.rep.ghlUserId;
      const proj = this.projected.get(id) ?? 0;
      if (proj >= l.rep.capacity) continue; // no headroom
      if (l.rep.states.length && st && !l.rep.states.includes(st)) continue; // territory miss
      if (proj < bestProjected) {
        best = l;
        bestProjected = proj;
      }
    }
    if (!best) return null;
    const id = best.rep.ghlUserId;
    this.projected.set(id, (this.projected.get(id) ?? 0) + 1);
    this.assigned.set(id, (this.assigned.get(id) ?? 0) + 1);
    return best.rep;
  }

  /** How many leads have been assigned to each rep so far this run. */
  assignmentCounts(): Array<{ rep: Rep; count: number }> {
    return this.loads.map((l) => ({ rep: l.rep, count: this.assigned.get(l.rep.ghlUserId) ?? 0 }));
  }
}

/** Number of leads worth pulling this run: total headroom, capped by maxPerRun. */
export function demand(loads: RepLoad[]): number {
  const headroom = loads.reduce((s, l) => s + l.headroom, 0);
  return Math.min(headroom, DISTRIBUTION.maxPerRun);
}
