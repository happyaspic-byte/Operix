import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { errorSummary } from "../src/lib/error-log.ts";
import { failure } from "../src/lib/http.ts";
import { runMaintenanceJobs } from "../src/lib/maintenance.ts";
import { AppError } from "../src/lib/policy.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);

// Shaped like what pg and PGlite throw: detail, hint and the rest echo row data.
function databaseError(
  code = "23505",
  message = "duplicate key value violates unique constraint",
) {
  return Object.assign(new Error(message), {
    name: "error",
    severity: "ERROR",
    code,
    detail: "Key (email)=(a@b.c) already exists.",
    hint: "Use a@b.c once.",
    where: "SQL statement \"INSERT INTO users(email) VALUES ('a@b.c')\"",
    table: "users",
    column: "email",
    constraint: "users_email_key",
    routine: "_bt_check_unique",
    query: "INSERT INTO users(email) VALUES ($1)",
    parameters: ["a@b.c"],
    internalQuery: "SELECT 'a@b.c'",
  });
}

test("errorSummary names a plain error and shows its message and frames", () => {
  const summary = errorSummary(new TypeError("boom"));
  assert.equal(summary.name, "TypeError");
  assert.equal(summary.message, "boom");
  // The first stack line repeats the message, so the frames start after it.
  assert.match(String(summary.stack), /^at /);
  assert.doesNotMatch(String(summary.stack), /TypeError: boom/);
});

test("errorSummary keeps database identifiers but never the message or row data", () => {
  const summary = errorSummary(databaseError());
  assert.deepEqual(
    { ...summary, stack: undefined },
    {
      name: "error",
      code: "23505",
      severity: "ERROR",
      table: "users",
      column: "email",
      constraint: "users_email_key",
      routine: "_bt_check_unique",
      stack: undefined,
    },
  );
  assert.doesNotMatch(JSON.stringify(summary), /a@b\.c/);
});

test("errorSummary cuts a message to 300 characters", () => {
  assert.equal(
    String(errorSummary(new Error("x".repeat(1000))).message).length,
    300,
  );
});

test("errorSummary keeps at most 8 trimmed frames and 1500 characters of stack", () => {
  const error = new Error("boom");
  error.stack = [
    "Error: boom",
    ...Array.from({ length: 20 }, (_, i) => `    at frame${i} (app.ts:${i}:1)`),
  ].join("\n");
  assert.deepEqual(
    String(errorSummary(error).stack).split("\n"),
    Array.from({ length: 8 }, (_, i) => `at frame${i} (app.ts:${i}:1)`),
  );
  error.stack = `Error: boom\n    at ${"f".repeat(5000)}`;
  assert.equal(String(errorSummary(error).stack).length, 1500);
});

test("errorSummary does not let a multi-line database message into the stack", () => {
  const error = databaseError("22007", 'bad date: "2026-01\nsecret-c@d.e"');
  assert.match(String(error.stack), /secret-c@d\.e/);
  const logged = JSON.stringify(errorSummary(error));
  assert.doesNotMatch(logged, /secret|c@d\.e/);
  assert.match(logged, /"code":"22007"/);
});

test("errorSummary summarises any value by type without throwing", () => {
  for (const [value, name] of [
    ["x", "string"],
    [null, "null"],
    [{}, "object"],
    [undefined, "undefined"],
    [42, "number"],
    [Symbol("s"), "symbol"],
    [() => {}, "function"],
  ] as const)
    assert.deepEqual(errorSummary(value), { name });
  const hostile = {
    get name(): string {
      throw new Error("name");
    },
    get code(): string {
      throw new Error("code");
    },
    get message(): string {
      throw new Error("message");
    },
    get stack(): string {
      throw new Error("stack");
    },
  };
  assert.deepEqual(errorSummary(hostile), { name: "object" });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(errorSummary(revoked.proxy), { name: "object" });
  const brokenStack = new RangeError("late");
  Object.defineProperty(brokenStack, "stack", {
    get() {
      throw new Error("stack");
    },
  });
  assert.deepEqual(errorSummary(brokenStack), {
    name: "RangeError",
    message: "late",
  });
});

test("an unexpected failure logs its cause once and answers with a generic 500", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const response = failure(new TypeError("boom"));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(log.mock.callCount(), 1);
  const line = JSON.parse(String(log.mock.calls[0].arguments[0]));
  assert.equal(line.event, "operix.request.failed");
  assert.equal(line.request_id, body.request_id);
  assert.equal(line.name, "TypeError");
  assert.equal(line.message, "boom");
  assert.equal(line.code, "internal_error");
  assert.doesNotMatch(JSON.stringify(body), /boom/);
});

test("a database failure is logged by identifiers only, without message, detail or parameters", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const response = failure(
    databaseError("22P02", 'invalid input syntax for type uuid: "a@b.c"'),
  );
  assert.equal(response.status, 500);
  assert.equal(log.mock.callCount(), 1);
  const text = String(log.mock.calls[0].arguments[0]);
  assert.doesNotMatch(text, /a@b\.c|invalid input/);
  const line = JSON.parse(text);
  assert.equal(line.event, "operix.request.failed");
  assert.equal(line.code, "22P02");
  assert.equal(line.constraint, "users_email_key");
  for (const key of [
    "message",
    "detail",
    "hint",
    "where",
    "query",
    "parameters",
    "internalQuery",
  ])
    assert.ok(!(key in line), key);
});

test("expected failures answer without a log line", (t) => {
  const log = t.mock.method(console, "error", () => {});
  assert.equal(failure(new AppError(400, "x")).status, 400);
  assert.equal(failure({ code: "55P03" }).status, 503);
  assert.equal(failure({ code: "23505" }).status, 409);
  assert.equal(failure({ code: "23503" }).status, 400);
  assert.equal(log.mock.callCount(), 0);
});

test("a failing maintenance job is logged and the other jobs still run", async () => {
  const ran: string[] = [];
  const lines: string[] = [];
  const ok = (name: string) => async () => {
    ran.push(name);
  };
  const failed = await runMaintenanceJobs(
    [
      ["a", ok("a")],
      [
        "b",
        async () => {
          ran.push("b");
          throw databaseError();
        },
      ],
      ["c", ok("c")],
    ],
    (line) => lines.push(line),
  );
  assert.deepEqual(failed, ["b"]);
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "operix.worker.job_failed");
  assert.equal(entry.job, "b");
  assert.equal(entry.code, "23505");
  assert.doesNotMatch(lines[0], /a@b\.c/);
});

test("maintenance jobs report every failure and log to console.error by default", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  assert.deepEqual(await runMaintenanceJobs([["a", async () => 1]]), []);
  assert.equal(log.mock.callCount(), 0);
  const failed = await runMaintenanceJobs([
    ["a", () => Promise.reject("not an error")],
    ["b", async () => 2],
    [
      "c",
      () => {
        throw new RangeError("synchronously");
      },
    ],
  ]);
  assert.deepEqual(failed, ["a", "c"]);
  const lines = log.mock.calls.map((call) =>
    JSON.parse(String(call.arguments[0])),
  );
  assert.deepEqual(
    lines.map((line) => [line.event, line.job, line.name]),
    [
      ["operix.worker.job_failed", "a", "string"],
      ["operix.worker.job_failed", "c", "RangeError"],
    ],
  );
});

// PGlite serves one process at a time: only call this while no script runs.
async function inDatabase<T>(dir: string, fn: (db: PGlite) => Promise<T>) {
  const db = new PGlite(dir);
  try {
    await db.waitReady;
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function runScript(dir: string, ...args: string[]) {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          CI: "true",
          DATABASE_URL: "",
          OPERIX_EMBEDDED: "1",
          PGLITE_PATH: dir,
          UPLOAD_DIR: join(dir, "uploads"),
          SESSION_SECRET: "error-log-test-session-secret-0123456789abcdef",
        },
        timeout: 90000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    // A timeout or a failure to start is not a script exit status.
    if (typeof error.code !== "number") throw error;
    return {
      code: error.code as number,
      stdout: error.stdout as string,
      stderr: error.stderr as string,
    };
  }
}

test(
  "the worker records which jobs failed, runs the rest and exits 1 with --once",
  { timeout: 240000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "operix-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const migrated = await runScript(dir, "scripts/migrate.ts");
    assert.equal(migrated.code, 0, migrated.stderr);
    // runJobs updates the scheduler row after the worker claimed its lease, so
    // only a heartbeat written when the pass ended is newer than that row.
    const workerState = () =>
      inDatabase(
        dir,
        async (db) =>
          (
            await db.query(
              "SELECT w.last_error,w.last_success IS NOT NULL succeeded,w.started_at IS NULL released,w.heartbeat_at>s.updated_at renewed FROM job_runs w,job_runs s WHERE w.id='worker' AND s.id='scheduler'",
            )
          ).rows[0],
      );
    await inDatabase(dir, async (db) => {
      await db.query(
        "INSERT INTO users(id,name,email,role,password_hash) VALUES('u1','Worker probe','worker-probe@operix.test','admin','unused')",
      );
      await db.query(
        "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by) VALUES('d1','customers','c1','probe.txt','text/plain',1,'00000000-0000-4000-8000-000000000001','u1')",
      );
      // runJobs and purgeDeletedFiles read these tables; scanPendingDocuments
      // does not.
      await db.exec(
        "ALTER TABLE tickets RENAME TO tickets_off; ALTER TABLE privacy_requests RENAME TO privacy_requests_off",
      );
    });

    const failed = await runScript(dir, "scripts/worker.ts", "--once");
    assert.equal(failed.code, 1, failed.stderr);
    const lines = failed.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => [line.event, line.job]),
      [
        ["operix.worker.job_failed", "runJobs"],
        ["operix.worker.job_failed", "purgeDeletedFiles"],
        ["operix.worker.failed", undefined],
      ],
    );
    for (const line of lines.slice(0, 2)) {
      assert.equal(line.code, "42P01");
      assert.equal(line.message, undefined);
    }
    assert.deepEqual(await workerState(), {
      last_error: "maintenance_failed:runJobs,purgeDeletedFiles",
      succeeded: false,
      released: true,
      renewed: true,
    });
    // scanPendingDocuments still ran after both failures.
    const [scanned] = await inDatabase(
      dir,
      async (db) =>
        (await db.query("SELECT scan_status,scan_error FROM documents")).rows,
    );
    assert.deepEqual(scanned, {
      scan_status: "error",
      scan_error: "file_unavailable",
    });

    await inDatabase(dir, (db) =>
      db.exec(
        "ALTER TABLE tickets_off RENAME TO tickets; ALTER TABLE privacy_requests_off RENAME TO privacy_requests",
      ),
    );
    const healthy = await runScript(dir, "scripts/worker.ts", "--once");
    assert.equal(healthy.code, 0, healthy.stderr);
    const completed = JSON.parse(
      healthy.stdout.split("\n").find((line) => line.startsWith("{")) ?? "{}",
    );
    assert.deepEqual(
      { ...completed, duration_ms: typeof completed.duration_ms },
      {
        event: "operix.worker.completed",
        duration_ms: "number",
        created: 0,
        notified: 0,
      },
    );
    assert.deepEqual(await workerState(), {
      last_error: null,
      succeeded: true,
      released: true,
      renewed: true,
    });
  },
);
