import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { errorSummary } from "../src/lib/error-log.ts";
import { failure } from "../src/lib/http.ts";
import {
  recordMaintenanceOutcome,
  runMaintenanceJobs,
} from "../src/lib/maintenance.ts";
import { AppError } from "../src/lib/policy.ts";
import { parseSheet } from "../src/lib/sheets.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { inDatabase, runScript } from "./helpers/script-db.ts";

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
    String(errorSummary(new RangeError("x".repeat(1000))).message).length,
    300,
  );
});

test("errorSummary keeps the message of programmer errors", () => {
  for (const error of [
    new TypeError("a is not a function"),
    new RangeError("Invalid time value"),
    new ReferenceError("b is not defined"),
  ])
    assert.equal(errorSummary(error).message, error.message);
});

test("errorSummary keeps the fixed connectivity messages of pg and pg-pool", () => {
  for (const message of [
    "timeout exceeded when trying to connect",
    "Connection terminated due to connection timeout",
    "Connection terminated unexpectedly",
    "Connection terminated",
    "Client has encountered a connection error and is not queryable",
    "Client was closed and is not queryable",
  ])
    assert.equal(errorSummary(new Error(message)).message, message);
  // Only the exact text: anything added to it could be data.
  for (const message of [
    "Connection terminated unexpectedly: kim@example.com",
    "connection terminated unexpectedly",
    " Connection terminated",
  ])
    assert.ok(!("message" in errorSummary(new Error(message))), message);
});

test("errorSummary logs no message for errors that can quote request data", async () => {
  const quoting: unknown[] = [new Error("kim@example.com")];
  quoting.push(new AppError(400, "kim@example.com"));
  try {
    JSON.parse("kim@example.com");
  } catch (error) {
    quoting.push(error);
  }
  // The error the CSV reader throws for an unterminated quote.
  await new ExcelJS.Workbook().csv
    .read(Readable.from(Buffer.from('name\n"open,kim@example.com\n')), {
      map: (value: string) => value,
    })
    .catch((error: unknown) => quoting.push(error));
  assert.equal(quoting.length, 4);
  for (const error of quoting) {
    // The premise: the error itself carries the address.
    assert.match(String((error as Error).message), /kim@example\.com/);
    const summary = errorSummary(error);
    assert.ok(!("message" in summary));
    assert.doesNotMatch(JSON.stringify(summary), /kim@example\.com/);
    assert.equal(summary.name, (error as Error).name);
    assert.match(String(summary.stack), /^at /);
  }
});

test("a malformed CSV upload answers 400 and nothing from the file is logged", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const upload = new File(['name\n"open,kim@example.com\n'], "bad.csv");
  let rejection: unknown;
  await assert.rejects(parseSheet(upload), (error) => {
    rejection = error;
    return error instanceof AppError && error.status === 400;
  });
  assert.equal(
    (rejection as Error).message,
    "CSV 내용을 읽을 수 없습니다. 따옴표와 열 구분을 확인해 주세요.",
  );
  const response = failure(rejection);
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(await response.json()), /kim@example/);
  assert.equal(log.mock.callCount(), 0);
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
  assert.doesNotMatch(logged, /secret-c@d\.e|bad date/);
  assert.match(logged, /"code":"22007"/);
});

test("errorSummary does not let a quoted line starting with 'at ' into the stack", () => {
  for (const quoted of [
    "line1\nat secret@x.y",
    "line1\n    at secret@x.y",
    "line1\r\nat secret@x.y",
  ]) {
    const error = databaseError(
      "22P02",
      `invalid input syntax for type uuid: "${quoted}"`,
    );
    assert.match(String(error.stack), /secret@x\.y/);
    const summary = errorSummary(error);
    assert.doesNotMatch(JSON.stringify(summary), /secret@x\.y/);
    assert.equal(summary.code, "22P02");
    assert.match(String(summary.stack), /^at databaseError /);
  }
});

test("errorSummary skips the header by the message's lines whatever name the header carries", () => {
  const message = 'invalid input syntax for type uuid: "line1\nat secret@x.y"';
  const error = Object.assign(new Error(message), {
    name: "error",
    code: "22P02",
  });
  // The header was written before the error was renamed.
  error.stack = [
    `Error: ${message}`,
    "    at frame0 (app.ts:1:1)",
    "    at frame1 (app.ts:2:1)",
  ].join("\n");
  assert.deepEqual(errorSummary(error), {
    name: "error",
    code: "22P02",
    stack: "at frame0 (app.ts:1:1)\nat frame1 (app.ts:2:1)",
  });
});

test("errorSummary falls back to the first frame when the stack does not carry the message", () => {
  const error = new TypeError("old one\nold two");
  void error.stack;
  error.message = "new";
  const summary = errorSummary(error);
  assert.equal(summary.message, "new");
  assert.match(String(summary.stack), /^at /);
  assert.doesNotMatch(String(summary.stack), /old (one|two)/);
  // A message found only further down is not the header.
  error.stack = "TypeError: old one\nold two\n    at frame0 (app.ts:1:1)";
  error.message = "frame0";
  assert.equal(errorSummary(error).stack, "at frame0 (app.ts:1:1)");
});

test("errorSummary logs no frames when a multi-line message cannot be found in the stack", () => {
  const quoted = 'invalid input syntax for type uuid: "line1\nat secret@x.y"';
  const error = Object.assign(new Error("while saving: " + quoted), {
    name: "error",
    code: "22P02",
  });
  // The header carries the message as it was before something prefixed it, so
  // the "at " line inside the quoted value would pass for the first frame.
  error.stack = [`Error: ${quoted}`, "    at frame0 (app.ts:1:1)"].join("\n");
  const summary = errorSummary(error);
  assert.deepEqual(summary, { name: "error", code: "22P02" });
  assert.ok(!("stack" in summary));
  assert.doesNotMatch(JSON.stringify(summary), /secret@x\.y/);
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
  assert.equal(failure({ code: "23505" }).status, 409);
  assert.equal(failure({ code: "23503" }).status, 400);
  assert.equal(log.mock.callCount(), 0);
});

test("a lock timeout answers 503 and logs one line with only its request id", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const response = failure(
    databaseError("55P03", "canceling statement due to lock timeout"),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  const body = await response.json();
  assert.equal(log.mock.callCount(), 1);
  const text = String(log.mock.calls[0].arguments[0]);
  assert.deepEqual(JSON.parse(text), {
    event: "operix.request.lock_timeout",
    request_id: body.request_id,
  });
  assert.doesNotMatch(text, /a@b\.c|users|lock timeout/);
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

// Stands in for the database: records each statement and fails the first
// `failures` of them with a database error.
function statusDb(failures = 0) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  return {
    calls,
    async query(sql: string, params?: any[]) {
      calls.push({ sql, params });
      if (calls.length <= failures)
        throw databaseError("57P01", "terminating connection");
      return [];
    },
  };
}

const fallbackUpdate =
  "UPDATE job_runs SET last_error='status_update_failed',started_at=NULL WHERE id='worker'";

test("recordMaintenanceOutcome records a clean pass with its duration", async () => {
  const db = statusDb();
  const lines: string[] = [];
  const recorded = await recordMaintenanceOutcome(
    db,
    { failed: [], durationMs: 1234 },
    (line) => lines.push(line),
  );
  assert.equal(recorded, true);
  assert.equal(db.calls.length, 1);
  const [{ sql, params }] = db.calls;
  for (const part of [
    "heartbeat_at=now()",
    "last_success=now()",
    "last_error=NULL",
    "last_duration_ms=$1",
    "started_at=NULL",
    "WHERE id='worker'",
  ])
    assert.ok(sql.includes(part), part);
  assert.deepEqual(params, [1234]);
  assert.deepEqual(lines, []);
});

test("recordMaintenanceOutcome names the failed jobs and leaves the last success alone", async () => {
  const cases: Array<[string[], string]> = [
    [["b"], "maintenance_failed:b"],
    [
      ["runJobs", "purgeDeletedFiles"],
      "maintenance_failed:runJobs,purgeDeletedFiles",
    ],
  ];
  for (const [failed, lastError] of cases) {
    const db = statusDb();
    assert.equal(
      await recordMaintenanceOutcome(db, { failed, durationMs: 9 }, () => {}),
      true,
    );
    assert.equal(db.calls.length, 1);
    const [{ sql, params }] = db.calls;
    for (const part of [
      "heartbeat_at=now()",
      "last_error=$1",
      "started_at=NULL",
      "WHERE id='worker'",
    ])
      assert.ok(sql.includes(part), part);
    assert.doesNotMatch(sql, /last_success|last_duration_ms/);
    assert.deepEqual(params, [lastError]);
  }
});

test("recordMaintenanceOutcome logs a failed status update, tries the fallback and still resolves", async () => {
  const db = statusDb(1);
  const lines: string[] = [];
  // The fallback works, but the status itself was not recorded.
  const recorded = await recordMaintenanceOutcome(
    db,
    { failed: [], durationMs: 5 },
    (line) => lines.push(line),
  );
  assert.equal(recorded, false);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[1].sql, fallbackUpdate);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, "operix.worker.status_failed");
  assert.equal(entry.code, "57P01");
  assert.doesNotMatch(lines[0], /a@b\.c|terminating/);
});

test("recordMaintenanceOutcome tries the fallback only once and logs that failure too", async () => {
  const db = statusDb(2);
  const lines: string[] = [];
  const recorded = await recordMaintenanceOutcome(
    db,
    { failed: ["b"], durationMs: 5 },
    (line) => lines.push(line),
  );
  assert.equal(recorded, false);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[1].sql, fallbackUpdate);
  // Only the second line says it came from the fallback.
  assert.deepEqual(
    lines.map((line) => {
      const entry = JSON.parse(line);
      return [entry.event, entry.stage];
    }),
    [
      ["operix.worker.status_failed", undefined],
      ["operix.worker.status_failed", "fallback"],
    ],
  );
  assert.doesNotMatch(lines.join("\n"), /a@b\.c|terminating/);
});

test("recordMaintenanceOutcome logs to console.error by default", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  assert.equal(
    await recordMaintenanceOutcome(statusDb(), { failed: [], durationMs: 1 }),
    true,
  );
  assert.equal(log.mock.callCount(), 0);
  assert.equal(
    await recordMaintenanceOutcome(statusDb(1), { failed: [], durationMs: 1 }),
    false,
  );
  assert.equal(log.mock.callCount(), 1);
  assert.equal(
    JSON.parse(String(log.mock.calls[0].arguments[0])).event,
    "operix.worker.status_failed",
  );
});

test("the fallback update releases the worker lease and flags the error in job_runs", async () => {
  const { db, close } = await isolatedDatabase();
  try {
    await db.query(
      "INSERT INTO job_runs(id,started_at,last_success) VALUES ('worker',now(),now())",
    );
    let refused = false;
    const flaky = {
      query: async (sql: string, params?: any[]) => {
        if (!refused) {
          refused = true;
          throw databaseError("57P01", "terminating connection");
        }
        return db.query(sql, params);
      },
    };
    assert.equal(
      await recordMaintenanceOutcome(
        flaky,
        { failed: [], durationMs: 5 },
        () => {},
      ),
      false,
    );
    const [row] = await db.query(
      "SELECT last_error,started_at,last_success IS NOT NULL succeeded FROM job_runs WHERE id='worker'",
    );
    assert.deepEqual(row, {
      last_error: "status_update_failed",
      started_at: null,
      succeeded: true,
    });
  } finally {
    await close();
  }
});

test(
  "the worker records which jobs failed, runs the rest and exits 1 with --once",
  { timeout: 240000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "operix-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const migrated = await runScript("migrate", {}, dir);
    assert.equal(migrated.code, 0, migrated.stderr);
    // runJobs updates the scheduler row after the worker claimed its lease, so
    // only a heartbeat written when the pass ended is newer than that row.
    const workerState = () =>
      inDatabase(
        async (db) =>
          (
            await db.query(
              "SELECT w.last_error,w.last_success IS NOT NULL succeeded,w.started_at IS NULL released,w.heartbeat_at>s.updated_at renewed FROM job_runs w,job_runs s WHERE w.id='worker' AND s.id='scheduler'",
            )
          ).rows[0],
        dir,
      );
    await inDatabase(async (db) => {
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
    }, dir);

    const failed = await runScript("worker", {}, dir, "--once");
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
      async (db) =>
        (await db.query("SELECT scan_status,scan_error FROM documents")).rows,
      dir,
    );
    assert.deepEqual(scanned, {
      scan_status: "error",
      scan_error: "file_unavailable",
    });

    await inDatabase(
      (db) =>
        db.exec(
          "ALTER TABLE tickets_off RENAME TO tickets; ALTER TABLE privacy_requests_off RENAME TO privacy_requests",
        ),
      dir,
    );
    const healthy = await runScript("worker", {}, dir, "--once");
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

test(
  "the worker exits 1 with --once when it cannot record its status",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "operix-worker-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const migrated = await runScript("migrate", {}, dir);
    assert.equal(migrated.code, 0, migrated.stderr);
    // Every job succeeds, but writing the pass's duration is refused. The claim
    // and the fallback update do not write it.
    await inDatabase(
      (db) =>
        db.exec(
          "ALTER TABLE job_runs ADD CONSTRAINT worker_no_duration CHECK (id<>'worker' OR last_duration_ms IS NULL)",
        ),
      dir,
    );

    const result = await runScript("worker", {}, dir, "--once");
    assert.equal(result.code, 1, result.stderr);
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, result.stderr);
    assert.equal(lines[0].event, "operix.worker.status_failed");
    assert.equal(lines[0].code, "23514");
    assert.equal(lines[0].constraint, "worker_no_duration");
    assert.ok(!("stage" in lines[0]));
    // The jobs themselves ran clean.
    assert.match(result.stdout, /"event":"operix.worker.completed"/);
    const [worker] = await inDatabase(
      async (db) =>
        (
          await db.query(
            "SELECT last_error,started_at IS NULL released,last_success IS NULL never_recorded FROM job_runs WHERE id='worker'",
          )
        ).rows,
      dir,
    );
    assert.deepEqual(worker, {
      last_error: "status_update_failed",
      released: true,
      never_recorded: true,
    });
  },
);
