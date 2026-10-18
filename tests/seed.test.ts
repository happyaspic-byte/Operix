import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const bootstrap = {
  ADMIN_EMAIL: "seed-admin@operix.test",
  ADMIN_PASSWORD: "Seed-test-password-123!",
};
const renamedEmail = "renamed-admin@operix.test";
const activeAdmins =
  "SELECT email FROM users WHERE role='admin' AND active AND deleted_at IS NULL AND privacy_erased_at IS NULL ORDER BY email";
const notActiveAdmin =
  /ADMIN_EMAIL belongs to an existing account that is not an active administrator\. Choose another ADMIN_EMAIL\./;

// Like `npm run db:migrate` and `npm run db:seed`, every script runs in its own
// process against one PGlite directory. The tests share that database and
// depend on running in order.
let dir: string;

async function runScript(name: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  for (const key of [
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "SEED_DEMO",
    "DEMO_PASSWORD",
  ])
    delete inherited[key];
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", `scripts/${name}.ts`],
      {
        cwd: root,
        env: {
          ...inherited,
          CI: "true",
          DATABASE_URL: "",
          OPERIX_EMBEDDED: "1",
          PGLITE_PATH: dir,
          SESSION_SECRET: "seed-test-session-secret-0123456789abcdef",
          ...env,
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
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

// PGlite serves one process at a time: only call this while no script runs.
async function inDatabase<T>(fn: (db: PGlite) => Promise<T>) {
  const db = new PGlite(dir);
  try {
    await db.waitReady;
    return await fn(db);
  } finally {
    await db.close();
  }
}

before(
  async () => {
    dir = await mkdtemp(join(tmpdir(), "operix-seed-"));
    const migrated = await runScript("migrate");
    assert.equal(migrated.code, 0, migrated.stderr);
  },
  { timeout: 120000 },
);
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("seeding an empty database requires ADMIN_EMAIL and ADMIN_PASSWORD", async () => {
  const result = await runScript("seed");
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of 12\+ characters before seeding\./,
  );
});

test("seeding with ADMIN_EMAIL and ADMIN_PASSWORD creates one active administrator", async () => {
  const result = await runScript("seed", bootstrap);
  assert.equal(result.code, 0, result.stderr);
  const { rows } = await inDatabase((db) => db.query(activeAdmins));
  assert.deepEqual(rows, [{ email: bootstrap.ADMIN_EMAIL }]);
});

test("seeding again after the administrator's email changed adds no second administrator", async () => {
  const renamed = await inDatabase((db) =>
    db.query("UPDATE users SET email=$1 WHERE email=$2", [
      renamedEmail,
      bootstrap.ADMIN_EMAIL,
    ]),
  );
  assert.equal(renamed.affectedRows, 1);

  const result = await runScript("seed", bootstrap);
  assert.equal(result.code, 0, result.stderr);
  const { rows } = await inDatabase((db) =>
    db.query("SELECT email FROM users WHERE role='admin'"),
  );
  assert.deepEqual(rows, [{ email: renamedEmail }]);
});

test("seeding without ADMIN_EMAIL and ADMIN_PASSWORD skips the bootstrap once an administrator exists", async () => {
  const result = await runScript("seed");
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes("Administrator already exists; bootstrap skipped."),
    result.stdout,
  );
});

test("demo seeding attributes its audit entries to the earliest active administrator", async () => {
  // The bootstrap administrator is the oldest but inactive. The later of the two
  // active administrators is inserted first, so only ordering by creation time
  // selects the earlier one.
  await inDatabase(async (db) => {
    await db.query("UPDATE users SET active=false WHERE role='admin'");
    for (const [id, hours] of [
      ["later-active-admin", 2],
      ["earliest-active-admin", 1],
    ] as const)
      await db.query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES ($1,$2,'Administrator','admin','unused',now() + $3 * interval '1 hour')",
        [id, `${id}@operix.test`, hours],
      );
  });

  const result = await runScript("seed", {
    SEED_DEMO: "1",
    DEMO_PASSWORD: "Demo-test-password-123!",
  });
  assert.equal(result.code, 0, result.stderr);
  const { rows } = await inDatabase((db) =>
    db.query(
      "SELECT DISTINCT user_id FROM audit_logs WHERE action='create' AND details->>'source'='synthetic demo seed'",
    ),
  );
  assert.deepEqual(rows, [{ user_id: "earliest-active-admin" }]);
});

test("seeding refuses an ADMIN_EMAIL that belongs to an account that is not an active administrator", async () => {
  await inDatabase(async (db) => {
    await db.query("UPDATE users SET active=false WHERE role='admin'");
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ('existing-viewer','existing-viewer@operix.test','Viewer','viewer','unused')",
    );
  });

  const result = await runScript("seed", {
    ADMIN_EMAIL: "existing-viewer@operix.test",
    ADMIN_PASSWORD: bootstrap.ADMIN_PASSWORD,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, notActiveAdmin);
  const admins = await inDatabase((db) => db.query(activeAdmins));
  assert.deepEqual(admins.rows, []);
  const viewer = await inDatabase((db) =>
    db.query("SELECT role, active FROM users WHERE email=$1", [
      "existing-viewer@operix.test",
    ]),
  );
  assert.deepEqual(viewer.rows, [{ role: "viewer", active: true }]);
});

test("seeding with a new ADMIN_EMAIL fails cleanly while the bootstrap account is not an active administrator", async () => {
  // The bootstrap account keeps its fixed id, so the new row collides on the
  // primary key rather than on the email.
  const result = await runScript("seed", {
    ADMIN_EMAIL: "new-admin@operix.test",
    ADMIN_PASSWORD: bootstrap.ADMIN_PASSWORD,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, notActiveAdmin);
  assert.doesNotMatch(result.stderr, /duplicate key/);
  const created = await inDatabase((db) =>
    db.query("SELECT 1 FROM users WHERE email=$1", ["new-admin@operix.test"]),
  );
  assert.deepEqual(created.rows, []);
});
