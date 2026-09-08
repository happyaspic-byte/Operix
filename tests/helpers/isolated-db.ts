import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { getDb, type Database } from "../../src/lib/db.ts";

export async function isolatedDatabase() {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    OPERIX_EMBEDDED: process.env.OPERIX_EMBEDDED,
    PGLITE_PATH: process.env.PGLITE_PATH,
  };
  const testUrl = process.env.TEST_DATABASE_URL;
  const schema = "operix_test_" + crypto.randomUUID().replaceAll("-", "");
  const admin = testUrl
    ? new Pool({ connectionString: testUrl, max: 1 })
    : null;
  let schemaCreated = false;
  let db: Database | undefined;
  let closed = false;

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await db?.close();
    } finally {
      try {
        if (schemaCreated)
          await admin!.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        try {
          await admin?.end();
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      }
    }
  }

  try {
    // Never reuse an application database URL as an implicit test database.
    process.env.DATABASE_URL = "";
    process.env.OPERIX_EMBEDDED = "1";
    process.env.PGLITE_PATH = "memory://";
    if (admin && testUrl) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      const url = new URL(testUrl);
      const options = url.searchParams.get("options") || "";
      // Apply to every connection in the application pool, including transactions.
      url.searchParams.set(
        "options",
        `${options} -c search_path=${schema}`.trim(),
      );
      process.env.DATABASE_URL = url.toString();
    }
    db = await getDb();
    for (const name of (await readdir("db"))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await db.exec(await readFile("db/" + name, "utf8"));
    return { db, close };
  } catch (error) {
    await close();
    throw error;
  }
}
