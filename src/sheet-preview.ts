import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAEFilters, toElementixArgs } from "./sheet.js";
import { listPeople } from "./elementix.js";

/**
 * Preview the AE-filter sheet: resolve each row to a GHL user + Elementix filter,
 * and do a tiny live Elementix pull to confirm the filter returns leads.
 * Source: SHEET_CSV_URL env, a CLI path arg, or the bundled sample CSV.
 */
async function main() {
  const src =
    process.env.SHEET_CSV_URL ||
    process.argv[2] ||
    fileURLToPath(new URL("../config/ae-filters.sample.csv", import.meta.url));
  const roster = JSON.parse(
    readFileSync(fileURLToPath(new URL("../config/roster.json", import.meta.url)), "utf8"),
  ).reps as Array<{ name: string; ghlUserId: string }>;

  const filters = await loadAEFilters(src, roster);
  console.log(`Loaded ${filters.length} AE filter row(s) from: ${src}\n`);

  for (const f of filters) {
    console.log(`${f.aeName}  →  GHL user ${f.ghlUserId || "(UNMATCHED — fix name)"}`);
    console.log(
      `  filter: state=${f.states.join(",") || "any"} | county=${f.counties.join(",") || "any"} | city=${f.cities.join(",") || "any"} | amount=$${(f.amountMin || 0).toLocaleString()}–$${(f.amountMax || 0).toLocaleString()} | loansMin=${f.loansMin ?? "-"} | region=${f.region || "-"}`,
    );
    try {
      const sample = await listPeople({ ...toElementixArgs(f), sortBy: "totalVolume", limit: 3 });
      console.log(`  Elementix sample: ${sample.length} lead(s)`);
      for (const p of sample) {
        const nm = p.name || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.uuid;
        console.log(`    • ${nm} — ${p.city || ""} ${p.state || ""}`.trimEnd());
      }
    } catch (e: any) {
      console.log(`  Elementix ERROR: ${e.message}`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
