import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inDatabase, runScript } from "./helpers/script-db.ts";

const bootstrap = {
  ADMIN_EMAIL: "seed-admin@operix.test",
  ADMIN_PASSWORD: "Seed-test-password-123!",
};
const renamedEmail = "renamed-admin@operix.test";
const activeAdmins =
  "SELECT email FROM users WHERE role='admin' AND active AND deleted_at IS NULL AND privacy_erased_at IS NULL ORDER BY email";
const notActiveAdmin =
  /ADMIN_EMAIL belongs to an existing account that is not an active administrator\. Choose another ADMIN_EMAIL\./;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// How scripts/seed.ts derives the ids of its demo data. The bootstrap
// administrator used to get demoId("admin"), which is UUID-shaped too.
function demoId(key: string) {
  const h = createHash("sha256")
    .update("operix-demo:" + key)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Like `npm run db:migrate` and `npm run db:seed`, every script runs in its own
// process against one PGlite directory. The tests share that database and
// depend on running in order, except the last, which brings its own.
let dir: string;

before(
  async () => {
    dir = await mkdtemp(join(tmpdir(), "operix-seed-"));
    const migrated = await runScript("migrate", {}, dir);
    assert.equal(migrated.code, 0, migrated.stderr);
  },
  { timeout: 120000 },
);
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("seeding an empty database requires ADMIN_EMAIL and ADMIN_PASSWORD", async () => {
  const result = await runScript("seed", {}, dir);
  assert.notEqual(result.code, 0);
  assert.match(
    result.stderr,
    /Set ADMIN_EMAIL and a unique ADMIN_PASSWORD of 12\+ characters before seeding\./,
  );
});

test("seeding with ADMIN_EMAIL and ADMIN_PASSWORD creates one active administrator", async () => {
  const result = await runScript("seed", bootstrap, dir);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes("Administrator bootstrap completed.\n"),
    result.stdout,
  );
  const { rows } = await inDatabase((db) => db.query(activeAdmins), dir);
  assert.deepEqual(rows, [{ email: bootstrap.ADMIN_EMAIL }]);
});

test("the bootstrap administrator's id is a UUID, not the fixed id derived for demo data", async () => {
  const { rows } = await inDatabase(
    (db) =>
      db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
        bootstrap.ADMIN_EMAIL,
      ]),
    dir,
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].id, uuid);
  assert.notEqual(rows[0].id, demoId("admin"));
});

test("seeding again after the administrator's email changed adds no second administrator", async () => {
  const renamed = await inDatabase(
    (db) =>
      db.query("UPDATE users SET email=$1 WHERE email=$2", [
        renamedEmail,
        bootstrap.ADMIN_EMAIL,
      ]),
    dir,
  );
  assert.equal(renamed.affectedRows, 1);

  const result = await runScript("seed", bootstrap, dir);
  assert.equal(result.code, 0, result.stderr);
  const { rows } = await inDatabase(
    (db) => db.query("SELECT email FROM users WHERE role='admin'"),
    dir,
  );
  assert.deepEqual(rows, [{ email: renamedEmail }]);
});

test("seeding without ADMIN_EMAIL and ADMIN_PASSWORD skips the bootstrap once an administrator exists", async () => {
  const result = await runScript("seed", {}, dir);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes("Administrator already exists; bootstrap skipped."),
    result.stdout,
  );
  assert.doesNotMatch(result.stdout, /Administrator bootstrap completed/);
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
  }, dir);

  const result = await runScript(
    "seed",
    { SEED_DEMO: "1", DEMO_PASSWORD: "Demo-test-password-123!" },
    dir,
  );
  assert.equal(result.code, 0, result.stderr);
  const { rows } = await inDatabase(
    (db) =>
      db.query(
        "SELECT DISTINCT user_id FROM audit_logs WHERE action='create' AND details->>'source'='synthetic demo seed'",
      ),
    dir,
  );
  assert.deepEqual(rows, [{ user_id: "earliest-active-admin" }]);
});

test("seeding refuses an ADMIN_EMAIL that belongs to an account that is not an active administrator", async () => {
  // A database of its own, so the email is the only thing the new row can
  // collide on.
  const fresh = await mkdtemp(join(tmpdir(), "operix-seed-"));
  try {
    const migrated = await runScript("migrate", {}, fresh);
    assert.equal(migrated.code, 0, migrated.stderr);
    await inDatabase(
      (db) =>
        db.query(
          "INSERT INTO users(id,email,name,role,password_hash) VALUES ('existing-viewer','existing-viewer@operix.test','Viewer','viewer','unused')",
        ),
      fresh,
    );

    const result = await runScript(
      "seed",
      {
        ADMIN_EMAIL: "existing-viewer@operix.test",
        ADMIN_PASSWORD: bootstrap.ADMIN_PASSWORD,
      },
      fresh,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, notActiveAdmin);
    const { rows } = await inDatabase(
      (db) => db.query("SELECT email, role, active FROM users"),
      fresh,
    );
    assert.deepEqual(rows, [
      { email: "existing-viewer@operix.test", role: "viewer", active: true },
    ]);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});
