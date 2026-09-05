import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { getDb } from "../src/lib/db.ts";
import { documentPath, documentRoot } from "../src/lib/documents.ts";
import { readTombstones, type Tombstone } from "../src/lib/privacy-ledger.ts";
import { replayTombstones } from "../src/lib/privacy.ts";
const db = await getDb(),
  action = process.argv[2],
  key = process.argv[3];
async function input() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return JSON.parse(data);
}
async function schemas() {
  return Promise.all(
    (await readdir("db"))
      .filter((n) => n.endsWith(".sql"))
      .sort()
      .map(async (name) => ({
        name,
        checksum: createHash("sha256")
          .update(await readFile("db/" + name))
          .digest("hex"),
      })),
  );
}
try {
  if (action === "manifest") {
    const docs = await db.query(
        "SELECT id,storage_key,size_bytes,sha256 FROM documents WHERE purged_at IS NULL ORDER BY id",
      ),
      files = [];
    for (const d of docs) {
      const bytes = await readFile(documentPath(d.storage_key));
      if (bytes.length !== Number(d.size_bytes))
        throw new Error("Stored file size mismatch");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (d.sha256 && d.sha256 !== digest)
        throw new Error("Stored file hash differs from upload metadata");
      files.push({
        id: d.id,
        key: d.storage_key,
        size: bytes.length,
        sha256: digest,
      });
    }
    const actual = (await readdir(documentRoot())).sort();
    if (
      JSON.stringify(actual) !== JSON.stringify(files.map((f) => f.key).sort())
    )
      throw new Error("Unexpected files in upload storage");
    console.log(
      JSON.stringify({
        version: 1,
        schemas: await schemas(),
        files,
        created_at: new Date().toISOString(),
      }),
    );
  } else if (action === "validate-schema") {
    const m = await input();
    if (
      m.version !== 1 ||
      JSON.stringify(m.schemas) !== JSON.stringify(await schemas())
    )
      throw new Error("Backup schema does not match this application image");
  } else if (action === "verify") {
    const m = await input();
    if (
      m.version !== 1 ||
      JSON.stringify(m.schemas) !== JSON.stringify(await schemas())
    )
      throw new Error("Schema mismatch");
    const rows = await db.query(
      "SELECT name,checksum FROM schema_migrations ORDER BY name",
    );
    if (JSON.stringify(rows) !== JSON.stringify(m.schemas))
      throw new Error("Restored database schema mismatch");
    const docs = await db.query(
      "SELECT id,storage_key,size_bytes,sha256 FROM documents WHERE purged_at IS NULL ORDER BY id",
    );
    if (docs.length !== m.files.length)
      throw new Error("Document count mismatch");
    for (const f of m.files) {
      if (
        !docs.some(
          (d) =>
            d.id === f.id &&
            d.storage_key === f.key &&
            Number(d.size_bytes) === f.size &&
            (!d.sha256 || d.sha256 === f.sha256),
        )
      )
        throw new Error("Document metadata mismatch");
      const bytes = await readFile(documentPath(f.key));
      if (
        bytes.length !== f.size ||
        createHash("sha256").update(bytes).digest("hex") !== f.sha256
      )
        throw new Error("Document hash mismatch");
    }
    if (
      JSON.stringify((await readdir(documentRoot())).sort()) !==
      JSON.stringify(m.files.map((f: { key: string }) => f.key).sort())
    )
      throw new Error("Restore volume contains extra files");
    await db.query("DELETE FROM sessions"); // A backup must not resurrect previous authenticated sessions.
  } else if (action === "tombstones") {
    let rows: Tombstone[] = [];
    try {
      rows = await db.query<Tombstone>(
        "SELECT * FROM privacy_tombstones ORDER BY erased_at,id",
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "42P01") throw e;
    }
    const all = [...rows, ...(await readTombstones())];
    console.log(
      JSON.stringify([...new Map(all.map((t) => [t.id, t])).values()]),
    );
  } else if (action === "replay") await replayTombstones(await input());
  else if (action === "backup-start")
    await db.query(
      "INSERT INTO backup_runs(id,status,expires_at) VALUES ($1,'running',NULL)",
      [key],
    );
  else if (action === "backup-complete")
    await db.query(
      "UPDATE backup_runs SET status='completed',completed_at=now(),manifest_hash=$2,encrypted=$3 WHERE id=$1",
      [key, process.argv[4], process.argv[5] !== "plain"],
    );
  else if (action === "backup-failed")
    await db.query(
      "UPDATE backup_runs SET status='failed',error_code='backup_failed' WHERE id=$1",
      [key],
    );
  else throw new Error("Unknown recovery command");
} finally {
  await db.close();
}
