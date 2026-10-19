import { Client, Pool, types, type ClientConfig, type PoolConfig } from "pg";
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
export const DB_TIME_ZONE = "Asia/Seoul";
export async function applySessionTimeZone(client: {
  query: (sql: string) => Promise<unknown>;
}): Promise<void> {
  await client.query(`SET TIME ZONE '${DB_TIME_ZONE}'`);
}
// pg-pool awaits onConnect before it hands out a new connection, so the
// session time zone never depends on the connection string.
export function poolConfig(connectionString: string): PoolConfig {
  return {
    connectionString,
    max: 8,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 30000,
    query_timeout: 35000,
    onConnect: applySessionTimeZone,
  };
}
let pending: Promise<Database> | undefined;
let metricsPool: Pool | undefined;
export function poolMetrics() {
  return metricsPool
    ? {
        total: metricsPool.totalCount,
        idle: metricsPool.idleCount,
        waiting: metricsPool.waitingCount,
      }
    : null;
}
export async function getDb(): Promise<Database> {
  if (!pending) pending = connect();
  return pending;
}
async function connect(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool(poolConfig(process.env.DATABASE_URL));
    metricsPool = pool;
    pool.on("error", () =>
      console.error(JSON.stringify({ event: "operix.database.pool_error" })),
    );
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
  await applySessionTimeZone(pg);
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
export const MIGRATION_LOCK_KEY = 7305010;
// Migrations run on their own connection so they do not inherit the pool's
// statement and query timeouts. pg never sends statement_timeout: 0, so
// connectForMigrations sets it explicitly.
export function migrationClientConfig(connectionString: string): ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: 10000,
    lock_timeout: 60000,
    application_name: "operix-migrate",
  };
}
export async function connectForMigrations(): Promise<Database> {
  if (!process.env.DATABASE_URL) return getDb();
  const client = new Client(migrationClientConfig(process.env.DATABASE_URL));
  await client.connect();
  try {
    await applySessionTimeZone(client);
    await client.query("SET statement_timeout = 0");
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  const db: Database = {
    query: async (sql, params = []) =>
      normalize((await client.query(sql, params)).rows) as any,
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction: async (fn) => {
      await client.query("BEGIN");
      try {
        const value = await fn(db);
        await client.query("COMMIT");
        return value;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    },
    close: () => client.end(),
  };
  return db;
}
