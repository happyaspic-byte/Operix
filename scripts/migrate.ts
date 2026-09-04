import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getDb } from "../src/lib/db.ts";
export async function migrate() {
  const db = await getDb();
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("db"))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(`db/${name}`, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const [existing] = await db.query(
      "SELECT checksum FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (existing) {
      if (existing.checksum !== checksum)
        throw new Error(`Migration changed: ${name}`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)",
        [name, checksum],
      );
    });
    console.log(`Applied ${name}`);
  }
}
await migrate();
await (await getDb()).close();
