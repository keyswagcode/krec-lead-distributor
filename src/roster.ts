import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Role = "AE" | "AAE";

export interface Rep {
  name: string;
  ghlUserId: string;
  role: Role;
  capacity: number;
  active: boolean;
  /** Optional 2-letter state codes this rep covers. Empty = any state. */
  states: string[];
}

interface RawRep {
  name?: string;
  ghlUserId?: string;
  role?: string;
  capacity?: number;
  active?: boolean;
  states?: string[];
}

const ROSTER_PATH = fileURLToPath(new URL("../config/roster.json", import.meta.url));

/**
 * Load and validate config/roster.json. Throws on malformed entries so a bad
 * roster fails the run loudly rather than silently misrouting leads.
 */
export function loadRoster(path = ROSTER_PATH): Rep[] {
  let parsed: { reps?: RawRep[] };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err: any) {
    throw new Error(`Could not read roster at ${path}: ${err.message}`);
  }

  const raw = parsed.reps;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Roster ${path} has no "reps" array.`);
  }

  const seen = new Set<string>();
  const reps: Rep[] = raw.map((r, i) => {
    if (!r.name) throw new Error(`Roster rep #${i} is missing "name".`);
    if (!r.ghlUserId || r.ghlUserId.startsWith("REPLACE_")) {
      throw new Error(`Roster rep "${r.name}" has no valid "ghlUserId" — fill it in config/roster.json.`);
    }
    if (r.role !== "AE" && r.role !== "AAE") {
      throw new Error(`Roster rep "${r.name}" has invalid role "${r.role}" (expected "AE" or "AAE").`);
    }
    if (typeof r.capacity !== "number" || r.capacity < 0) {
      throw new Error(`Roster rep "${r.name}" has invalid "capacity".`);
    }
    if (seen.has(r.ghlUserId)) {
      throw new Error(`Roster has duplicate ghlUserId "${r.ghlUserId}" (rep "${r.name}").`);
    }
    seen.add(r.ghlUserId);
    return {
      name: r.name,
      ghlUserId: r.ghlUserId,
      role: r.role,
      capacity: r.capacity,
      active: r.active !== false,
      states: (r.states || []).map((s) => s.toUpperCase()),
    };
  });

  return reps;
}

/** Reps eligible to receive new leads this run. */
export function activeReps(reps: Rep[]): Rep[] {
  return reps.filter((r) => r.active);
}
