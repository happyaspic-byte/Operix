import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  connectForMigrations,
  MIGRATION_LOCK_KEY,
  migrationClientConfig,
} from "../src/lib/db.ts";
import { runScript } from "./helpers/script-db.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const postgresUrl = "postgresql://u:p@db:5432/operix";
const sessionSetup = [
  "SET TIME ZONE 'Asia/Seoul'",
  "SET statement_timeout = 0",
];
const lock = `SELECT pg_advisory_lock($1) [${MIGRATION_LOCK_KEY}]`;
const unlock = `SELECT pg_advisory_unlock($1) [${MIGRATION_LOCK_KEY}]`;

async function migrationNames() {
  return (await readdir(join(root, "db")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

// Stands in for PostgreSQL: pg clients never connect, every statement is
// recorded, and schema_migrations is answered from the name -> checksum ledger.
function fakePostgres(
  t: TestContext,
  ledger = new Map<string, string>(),
  failing = new Map<string, Error>(),
) {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = postgresUrl;
  t.after(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });
  const clients = new Set<any>();
  const sent: string[] = [];
  t.mock.method(Client.prototype, "connect", async function (this: Client) {
    clients.add(this);
  });
  t.mock.method(
    Client.prototype,
    "query",
    async function (this: Client, sql: string, params: unknown[] = []) {
      clients.add(this);
      sent.push(params.length ? `${sql} ${JSON.stringify(params)}` : sql);
      const error = failing.get(sql);
      if (error) throw error;
      if (sql.startsWith("SELECT checksum FROM schema_migrations")) {
        const checksum = ledger.get(String(params[0]));
        return { rows: checksum ? [{ checksum }] : [] };
      }
      if (sql.startsWith("INSERT INTO schema_migrations"))
        ledger.set(String(params[0]), String(params[1]));
      return {
        rows:
          sql === "SELECT dates"
            ? [
                {
                  planned_date: new Date("2026-10-18T00:00:00Z"),
                  created_at: new Date("2026-10-18T15:30:00Z"),
                },
              ]
            : [],
      };
    },
  );
  t.mock.method(Client.prototype, "end", async function (this: Client) {
    clients.add(this);
    sent.push("end");
    const error = failing.get("end");
    if (error) throw error;
  });
  return { clients, sent, ledger };
}

const applied = (lines: string[]) =>
  lines.filter((line) => line.startsWith("Applied "));

test("the migration client takes the connection string as pg parses it", () => {
  for (const [connectionString, password, options] of [
    ["postgresql://operix:p%ssw0rd!@db:5432/operix", "p%ssw0rd!", undefined],
    [
      "postgresql://u:p@db:5432/operix?options=-c%20search_path%3Dtest_schema&sslmode=disable",
      "p",
      "-c search_path=test_schema",
    ],
  ] as const) {
    const parameters = (
      new Client(migrationClientConfig(connectionString)) as any
    ).connectionParameters;
    assert.equal(parameters.password, password);
    assert.equal(parameters.options, options);
  }
});

test("the migration client config leaves out the pool's request timeouts", () => {
  const config = migrationClientConfig(postgresUrl);
  assert.deepEqual(config, {
    connectionString: postgresUrl,
    connectionTimeoutMillis: 10000,
    lock_timeout: 60000,
    application_name: "operix-migrate",
  });
  assert.equal("query_timeout" in config, false);
  assert.equal("statement_timeout" in config, false);
});

test("the PostgreSQL migration connection is one client with explicit transactions", async (t) => {
  const { clients, sent } = fakePostgres(t);
  const db = await connectForMigrations();
  assert.deepEqual(await db.query("SELECT dates"), [
    { planned_date: "2026-10-18", created_at: "2026-10-18T15:30:00.000Z" },
  ]);
  await db.transaction(async (tx) => {
    await tx.exec("CREATE TABLE probe()");
    await tx.query("INSERT INTO probe VALUES ($1)", [1]);
  });
  await assert.rejects(
    db.transaction(async () => {
      throw new Error("rolled back");
    }),
    /rolled back/,
  );
  await db.close();

  assert.deepEqual(sent, [
    ...sessionSetup,
    "SELECT dates",
    "BEGIN",
    "CREATE TABLE probe()",
    "INSERT INTO probe VALUES ($1) [1]",
    "COMMIT",
    "BEGIN",
    "ROLLBACK",
    "end",
  ]);
  assert.equal(clients.size, 1);
  const parameters = [...clients][0].connectionParameters;
  assert.equal(parameters.application_name, "operix-migrate");
  assert.equal(parameters.lock_timeout, 60000);
  assert.ok(!parameters.statement_timeout);
  assert.ok(!parameters.query_timeout);
});

test("a failing session setup ends the migration client and rethrows the original error", async (t) => {
  const failing = new Map<string, Error>();
  const { sent } = fakePostgres(t, new Map(), failing);
  for (const [index, statement] of sessionSetup.entries()) {
    const error = new Error(`${statement} failed`);
    failing.clear();
    failing.set(statement, error);
    sent.length = 0;
    await assert.rejects(connectForMigrations(), (thrown) => thrown === error);
    // The client is ended right after the failing statement, once.
    assert.deepEqual(sent, [...sessionSetup.slice(0, index + 1), "end"]);

    // A client that cannot even end does not hide the cause.
    failing.set("end", new Error("end failed"));
    sent.length = 0;
    await assert.rejects(connectForMigrations(), (thrown) => thrown === error);
    assert.deepEqual(sent, [...sessionSetup.slice(0, index + 1), "end"]);
  }
});

test("on PostgreSQL migrate locks the whole run and a changed migration still fails", async (t) => {
  const { sent, ledger } = fakePostgres(t);
  const log = t.mock.method(console, "log", () => {});
  const names = await migrationNames();
  const logged = () => log.mock.calls.map((call) => String(call.arguments[0]));

  // Importing the script runs it once, as `node scripts/migrate.ts` does.
  const { migrate } = await import("../scripts/migrate.ts");
  assert.deepEqual(sent.slice(0, 3), [...sessionSetup, lock]);
  assert.match(sent[3], /^CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.deepEqual(sent.slice(-2), [unlock, "end"]);
  assert.equal(sent.filter((sql) => sql.includes("pg_advisory")).length, 2);
  assert.deepEqual(
    applied(logged()),
    names.map((name) => `Applied ${name}`),
  );
  assert.deepEqual([...ledger.keys()], names);

  // A second run finds every checksum in the ledger and applies nothing.
  sent.length = 0;
  log.mock.resetCalls();
  await migrate();
  assert.deepEqual(sent.slice(0, 3), [...sessionSetup, lock]);
  assert.deepEqual(sent.slice(-2), [unlock, "end"]);
  assert.ok(!sent.includes("BEGIN"));
  assert.deepEqual(applied(logged()), []);

  // A changed migration stops the run, which still releases the lock.
  sent.length = 0;
  ledger.set("001_initial.sql", "changed");
  await assert.rejects(migrate(), /Migration changed: 001_initial\.sql/);
  assert.deepEqual(sent.slice(0, 3), [...sessionSetup, lock]);
  assert.deepEqual(sent.slice(-2), [unlock, "end"]);
  assert.ok(!sent.includes("BEGIN"));
});

test(
  "migrate applies every migration once and a second run applies nothing",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "operix-migrate-"));
    try {
      const names = await migrationNames();
      assert.equal(names[0], "001_initial.sql");
      assert.ok(names.includes("007_backup_replication.sql"));

      const first = await runScript("migrate", {}, dir);
      assert.equal(first.code, 0, first.stderr);
      assert.deepEqual(
        applied(first.stdout.split("\n")),
        names.map((name) => `Applied ${name}`),
      );
      const second = await runScript("migrate", {}, dir);
      assert.equal(second.code, 0, second.stderr);
      assert.deepEqual(applied(second.stdout.split("\n")), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
