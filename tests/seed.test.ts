import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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
  "SELECT id, email FROM users WHERE role='admin' AND active AND deleted_at IS NULL AND privacy_erased_at IS NULL ORDER BY email";
const notActiveAdmin =
  /ADMIN_EMAIL belongs to an existing account that is not an active administrator\. Choose another ADMIN_EMAIL\./;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Older deployments' bootstrap administrator has this fixed id: sha256("operix-demo:admin"), formatted as in scripts/seed.ts.
const legacyAdminId = "3e963976-44c5-4522-8809-f7ce04661036";

// Like `npm run db:migrate` and `npm run db:seed`, every script runs in its own
// process against one PGlite directory. The tests share that database and
// depend on running in order, except the last two, which bring their own.
let dir: string;
let bootstrapAdminId = "";

// A database of its own, so the email is the only thing a new row can collide on.
async function inFreshDatabase(run: (fresh: string) => Promise<void>) {
  const fresh = await mkdtemp(join(tmpdir(), "operix-seed-"));
  try {
    const migrated = await runScript("migrate", {}, fresh);
    assert.equal(migrated.code, 0, migrated.stderr);
    await run(fresh);
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
}

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
  const { rows } = await inDatabase(
    (db) => db.query<{ id: string; email: string }>(activeAdmins),
    dir,
  );
  assert.deepEqual(
    rows.map((row) => row.email),
    [bootstrap.ADMIN_EMAIL],
  );
  bootstrapAdminId = rows[0].id;
});

test("the bootstrap administrator's id is a UUID, not the fixed id derived for demo data", () => {
  assert.match(bootstrapAdminId, uuid);
  assert.notEqual(bootstrapAdminId, legacyAdminId);
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

test("seeding refuses an ADMIN_EMAIL that belongs to an account that is not an active administrator", () =>
  inFreshDatabase(async (fresh) => {
    await inDatabase(
      (db) =>
        db.query(
          "INSERT INTO users(id,email,name,role,password_hash) VALUES ('existing-viewer','existing-viewer@operix.test','Viewer','viewer','unused')",
        ),
      fresh,
    );
    const viewer = {
      email: "existing-viewer@operix.test",
      role: "viewer",
      active: true,
    };
    const users = () =>
      inDatabase(
        (db) =>
          db.query("SELECT email, role, active FROM users ORDER BY email"),
        fresh,
      );

    const refused = await runScript(
      "seed",
      {
        ADMIN_EMAIL: "existing-viewer@operix.test",
        ADMIN_PASSWORD: bootstrap.ADMIN_PASSWORD,
      },
      fresh,
    );
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, notActiveAdmin);
    assert.deepEqual((await users()).rows, [viewer]);

    // Choosing another ADMIN_EMAIL recovers from the refusal.
    const recovered = await runScript(
      "seed",
      {
        ADMIN_EMAIL: "recovered-admin@operix.test",
        ADMIN_PASSWORD: bootstrap.ADMIN_PASSWORD,
      },
      fresh,
    );
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.ok(
      recovered.stdout.includes("Administrator bootstrap completed.\n"),
      recovered.stdout,
    );
    assert.deepEqual((await users()).rows, [
      viewer,
      { email: "recovered-admin@operix.test", role: "admin", active: true },
    ]);
  }));

test("seeding bootstraps an administrator when the only admins are deleted or erased", () =>
  inFreshDatabase(async (fresh) => {
    await inDatabase(async (db) => {
      // deleted_users_inactive keeps a deleted account inactive; drop it in
      // this database so the deleted_at term of the predicate is what decides.
      await db.exec("ALTER TABLE users DROP CONSTRAINT deleted_users_inactive");
      await db.exec(
        "INSERT INTO users(id,email,name,role,password_hash,active,deleted_at) VALUES ('deleted-admin','deleted-admin@operix.test','Deleted','admin','unused',true,now())",
      );
      await db.exec(
        "INSERT INTO users(id,email,name,role,password_hash,active,privacy_erased_at) VALUES ('erased-admin','erased-admin@operix.test','Erased','admin','unused',true,now())",
      );
    }, fresh);

    const result = await runScript("seed", bootstrap, fresh);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes("Administrator bootstrap completed.\n"),
      result.stdout,
    );
    assert.doesNotMatch(result.stdout, /bootstrap skipped/);
    const { rows } = await inDatabase(
      (db) => db.query<{ email: string }>(activeAdmins),
      fresh,
    );
    assert.deepEqual(
      rows.map((row) => row.email),
      [bootstrap.ADMIN_EMAIL],
    );
  }));
