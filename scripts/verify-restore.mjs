import { Pool } from "pg";
const original = new Pool({ connectionString: process.env.DATABASE_URL });
const restored = new Pool({
  connectionString: process.env.RESTORE_DATABASE_URL,
});
const tables = [
  "customers",
  "sites",
  "assets",
  "components",
  "vms",
  "contracts",
  "contract_assets",
  "inspections",
  "inspection_assets",
  "tickets",
  "entries",
  "documents",
  "reports",
  "users",
];
for (const table of tables) {
  const a = await original.query(`SELECT count(*)::int n FROM ${table}`);
  const b = await restored.query(`SELECT count(*)::int n FROM ${table}`);
  if (a.rows[0].n !== b.rows[0].n)
    throw new Error(`Restore mismatch: ${table}`);
  console.log(`${table}: ${a.rows[0].n} rows verified`);
}
const a = await original.query("SELECT id,snapshot FROM reports ORDER BY id");
const b = await restored.query("SELECT id,snapshot FROM reports ORDER BY id");
if (JSON.stringify(a.rows) !== JSON.stringify(b.rows))
  throw new Error("Report snapshots differ");
const targets =
  "SELECT inspection_id,asset_id FROM inspection_assets ORDER BY inspection_id,asset_id";
const originalTargets = await original.query(targets);
const restoredTargets = await restored.query(targets);
if (
  JSON.stringify(originalTargets.rows) !== JSON.stringify(restoredTargets.rows)
)
  throw new Error("Inspection target links differ");
await original.end();
await restored.end();
console.log("Database restore verification passed.");
