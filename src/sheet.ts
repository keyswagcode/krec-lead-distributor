import { readFileSync } from "node:fs";

/**
 * Loads per-AE lead-routing filters from the "AE filters" Google Sheet
 * (published to the web as CSV). Each row defines one AE's pull rules, which map
 * directly to Elementix listPeople filters. Set SHEET_CSV_URL to the published
 * CSV URL (File → Share → Publish to web → CSV).
 *
 * Expected columns (matched by header name, order-independent):
 *   AE Name | Loan Size Range | Loan Count | Region | State | County | City
 */

export interface AEFilter {
  aeName: string;
  ghlUserId: string | null;
  amountMin?: number;
  amountMax?: number;
  loansMin?: number;
  states: string[]; // 2-letter codes
  counties: string[];
  cities: string[];
  region?: string;
}

const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

function toStateCode(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return STATE_CODES[t.toLowerCase()] || null;
}

/** "$300,000-10000000" / "$300k - $10M" → { min, max }. */
function parseRange(s: string): { min?: number; max?: number } {
  const nums = (s.match(/[\d.,]+\s*[kmKM]?/g) || []).map((tok) => {
    let n = Number(tok.replace(/[,\s]/g, "").replace(/[kmKM]$/i, ""));
    if (/k$/i.test(tok)) n *= 1_000;
    if (/m$/i.test(tok)) n *= 1_000_000;
    return n;
  }).filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) return {};
  if (nums.length === 1) return { min: nums[0] };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Minimal CSV parse (handles quoted fields with commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Fuzzy-match a sheet AE name to a roster name → ghlUserId (tolerates typos). */
function resolveUserId(aeName: string, roster: Array<{ name: string; ghlUserId: string }>): string | null {
  const target = norm(aeName);
  let best: { id: string; dist: number } | null = null;
  for (const r of roster) {
    const dist = levenshtein(target, norm(r.name));
    if (best === null || dist < best.dist) best = { id: r.ghlUserId, dist };
  }
  return best && best.dist <= 3 ? best.id : null;
}

/** Read CSV from an http(s) URL or a local file path or raw CSV text. */
async function readSource(src: string): Promise<string> {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`Sheet CSV fetch ${r.status} — is it Published to web as CSV?`);
    return r.text();
  }
  if (src.includes("\n") || src.includes(",")) return src; // already CSV text
  return readFileSync(src, "utf8");
}

export async function loadAEFilters(
  src: string,
  roster: Array<{ name: string; ghlUserId: string }>,
): Promise<AEFilter[]> {
  const rows = parseCsv(await readSource(src));
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h.includes(name));
  const ci = {
    name: col("ae name") >= 0 ? col("ae name") : col("name"),
    range: col("loan size"),
    loans: col("loan count"),
    region: col("region"),
    state: col("state"),
    county: col("county"),
    city: col("city"),
  };
  const out: AEFilter[] = [];
  for (const r of rows.slice(1)) {
    const aeName = (r[ci.name] || "").trim();
    if (!aeName) continue;
    const { min, max } = ci.range >= 0 ? parseRange(r[ci.range] || "") : {};
    const loansRaw = ci.loans >= 0 ? Number((r[ci.loans] || "").replace(/[^\d]/g, "")) : NaN;
    const states = ci.state >= 0 ? (r[ci.state] || "").split(/[,/;]/).map(toStateCode).filter(Boolean) as string[] : [];
    const counties = ci.county >= 0 ? (r[ci.county] || "").split(/[,/;]/).map((s) => s.trim()).filter(Boolean) : [];
    const cities = ci.city >= 0 ? (r[ci.city] || "").split(/[,/;]/).map((s) => s.trim()).filter(Boolean) : [];
    out.push({
      aeName,
      ghlUserId: resolveUserId(aeName, roster),
      amountMin: min,
      amountMax: max,
      loansMin: Number.isFinite(loansRaw) && loansRaw > 0 ? loansRaw : undefined,
      states,
      counties,
      cities,
      region: ci.region >= 0 ? (r[ci.region] || "").trim() : undefined,
    });
  }
  return out;
}

/** Map an AE filter to Elementix listPeople args. */
export function toElementixArgs(f: AEFilter) {
  return {
    state: f.states[0], // listPeople takes one state; multi-state handled per-state by caller
    countyName: f.counties.length ? f.counties : undefined,
    city: f.cities.length ? f.cities : undefined,
    loanAmountMin: f.amountMin,
    loanAmountMax: f.amountMax,
    loansMin: f.loansMin,
    isBusinessPurpose: true,
  };
}
