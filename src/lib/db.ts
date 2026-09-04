import { Pool, types } from "pg";
types.setTypeParser(1082, (value) => value);
import { PGlite } from "@electric-sql/pglite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export type Row = Record<string, any>;
export interface Database {
  query<T extends Row = Row>(sql: string, params?: any[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
function normalize(rows: Row[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        value instanceof Date
          ? ["start_date", "end_date", "planned_date", "observed_at"].includes(
              key,
            )
            ? value.toISOString().slice(0, 10)
            : value.toISOString()
          : value,
      ]),
    ),
  );
}
let pending: Promise<Database> | undefined;
export async function getDb(): Promise<Database> {
  if (!pending) pending = connect();
  return pending;
}
async function connect(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
    });
    const wrap = (client: any): Database => ({
      query: async (sql, params = []) =>
        normalize((await client.query(sql, params)).rows) as any,
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const value = await fn(wrap(c));
          await c.query("COMMIT");
          return value;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
      close: async () => {
        await pool.end();
        pending = undefined;
      },
    });
    return wrap(pool);
  }
  if (process.env.OPERIX_EMBEDDED !== "1")
    throw new Error(
      "DATABASE_URL is required. Embedded database is only enabled explicitly for local verification.",
    );
  const path = process.env.PGLITE_PATH || ".data/operix";
  if (!path.startsWith("memory://"))
    await mkdir(dirname(path), { recursive: true });
  const pg = new PGlite(path);
  await pg.waitReady;
  const wrap = (client: any): Database => ({
    query: async (sql, params = []) =>
      normalize((await client.query(sql, params)).rows) as any,
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: async (fn) => client.transaction((tx: any) => fn(wrap(tx))),
    close: async () => {
      await pg.close();
      pending = undefined;
    },
  });
  return wrap(pg);
}
