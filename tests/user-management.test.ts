import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  attemptLogin,
  createSession,
  hashPassword,
  resolveSession,
  type User,
} from "../src/lib/auth.ts";
import type { Database, Row } from "../src/lib/db.ts";
import { AppError } from "../src/lib/policy.ts";
import { listUsers, saveUser, setUserDeleted } from "../src/lib/users.ts";
import { listReports } from "../src/lib/reports.ts";
import { details } from "../src/lib/details.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let db: Database;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
const previousSecret = process.env.SESSION_SECRET;
const password = "Synthetic-account-password-2026!";
let passwordHash: string;
let actor: Row & User;

before(async () => {
  process.env.SESSION_SECRET = "user-management-isolated-test-secret-only-2026";
  fixture = await isolatedDatabase();
  db = fixture.db;
  passwordHash = await hashPassword(password);
  actor = await rawUser({ role: "admin", name: "Current administrator" });
});

after(async () => {
  await fixture?.close();
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

const status = (expected: number) => (error: unknown) =>
  error instanceof AppError && error.status === expected;

async function rawUser(overrides: Row = {}): Promise<Row & User> {
  const id = crypto.randomUUID();
  const input = {
    id,
    email: id + "@example.test",
    name: "Synthetic account",
    role: "engineer",
    active: true,
    department: "",
    job_title: "",
    ...overrides,
  };
  const [row] = await db.query<Row & User>(
    "INSERT INTO users(id,email,name,role,active,password_hash,department,job_title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [
      input.id,
      input.email,
      input.name,
      input.role,
      input.active,
      passwordHash,
      input.department,
      input.job_title,
    ],
  );
  return row;
}

function invite(overrides: Row = {}) {
  return {
    email: crypto.randomUUID() + "@example.test",
    name: "Invited account",
    role: "engineer",
    active: true,
    password,
    ...overrides,
  };
}

function updateInput(row: Row, overrides: Row = {}) {
  return {
    id: row.id,
    version: row.version,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    ...overrides,
  };
}

async function persisted(id: string) {
  const [row] = await db.query("SELECT * FROM users WHERE id=$1", [id]);
  assert.ok(row);
  return row;
}

async function sessions(id: string) {
  return db.query("SELECT id FROM sessions WHERE user_id=$1", [id]);
}

function sanitized(row: Row) {
  assert.equal(Object.hasOwn(row, "password_hash"), false);
  assert.equal(Object.hasOwn(row, "password"), false);
}

test("An inactive account cannot receive a new session", async () => {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash,active) VALUES ($1,$2,'Inactive account','engineer','unused-test-password',false)",
    [id, id + "@example.test"],
  );
  await assert.rejects(() => createSession(id), status(401));
  assert.deepEqual(
    await db.query("SELECT id FROM sessions WHERE user_id=$1", [id]),
    [],
  );
});

test("Account creation trims department and job title without returning credentials", async () => {
  const input = invite({
    department: "  기술지원  ",
    job_title: "  선임 엔지니어  ",
  });
  const row = await saveUser(actor, input);
  assert.equal(row.department, "기술지원");
  assert.equal(row.job_title, "선임 엔지니어");
  assert.equal(row.version, 1);
  sanitized(row);
  const stored = await persisted(row.id);
  assert.equal(stored.department, "기술지원");
  assert.equal(stored.job_title, "선임 엔지니어");
  assert.notEqual(stored.password_hash, password);
  assert.ok(stored.password_hash.startsWith("scrypt:"));
});

test("Legacy account creation defaults the new profile fields to empty strings", async () => {
  const row = await saveUser(actor, invite());
  assert.equal(row.department, "");
  assert.equal(row.job_title, "");
  const listed = (await listUsers(actor)).find(
    (candidate) => candidate.id === row.id,
  );
  assert.ok(listed);
  assert.equal(listed.department, "");
  assert.equal(listed.job_title, "");
  sanitized(listed);
});

test("Legacy updates preserve omitted profile fields while explicit empty values clear them", async () => {
  const row = await rawUser({
    department: "Support",
    job_title: "Senior engineer",
  });
  const cookie = await createSession(row.id);
  const updated = await saveUser(
    actor,
    updateInput(row, { name: "Updated account name" }),
  );
  assert.equal(updated.department, "Support");
  assert.equal(updated.job_title, "Senior engineer");
  assert.equal(updated.version, row.version + 1);
  assert.equal((await persisted(row.id)).password_hash, passwordHash);
  assert.deepEqual(await sessions(row.id), []);
  assert.equal(await resolveSession(cookie), null);
  const cleared = await saveUser(
    actor,
    updateInput(updated, { department: "   ", job_title: "" }),
  );
  assert.equal(cleared.department, "");
  assert.equal(cleared.job_title, "");
  sanitized(cleared);
});

test("Profile fields accept 100 characters and reject longer or non-string replacements atomically", async () => {
  const row = await rawUser();
  const boundary = await saveUser(
    actor,
    updateInput(row, {
      department: "d".repeat(100),
      job_title: "t".repeat(100),
    }),
  );
  assert.equal(boundary.department.length, 100);
  assert.equal(boundary.job_title.length, 100);
  for (const field of ["department", "job_title"]) {
    for (const value of ["x".repeat(101), 12, null]) {
      await assert.rejects(
        () =>
          saveUser(
            actor,
            updateInput(boundary, { name: "Must not persist", [field]: value }),
          ),
        status(400),
      );
      const stored = await persisted(row.id);
      assert.equal(stored.name, boundary.name);
      assert.equal(stored.version, boundary.version);
      assert.equal(stored.department, boundary.department);
      assert.equal(stored.job_title, boundary.job_title);
    }
  }
});

test("Only administrators can list, save or delete accounts", async () => {
  const target = await rawUser();
  for (const role of ["manager", "engineer", "sales", "viewer"] as const) {
    const denied = await rawUser({ role });
    await assert.rejects(() => listUsers(denied), status(403));
    await assert.rejects(
      () =>
        saveUser(denied, updateInput(target, { name: "Unauthorized change" })),
      status(403),
    );
    await assert.rejects(
      () =>
        setUserDeleted(denied, {
          id: target.id,
          version: target.version,
          deleted: true,
        }),
      status(403),
    );
  }
  const stored = await persisted(target.id);
  assert.equal(stored.name, target.name);
  assert.equal(stored.version, target.version);
  assert.equal(stored.deleted_at, null);
});

test("Stale administrator objects cannot bypass current account status or role checks", async () => {
  const target = await rawUser();
  for (const change of [
    "active=false",
    "active=false,deleted_at=now()",
    "privacy_erased_at=now()",
    "role='engineer'",
  ]) {
    const staleActor = await rawUser({ role: "admin" });
    await db.query(`UPDATE users SET ${change} WHERE id=$1`, [staleActor.id]);
    await assert.rejects(() => listUsers(staleActor), status(403));
    await assert.rejects(() => saveUser(staleActor, invite()), status(403));
    await assert.rejects(
      () =>
        setUserDeleted(staleActor, {
          id: target.id,
          version: target.version,
          deleted: true,
        }),
      status(403),
    );
  }
  assert.equal((await persisted(target.id)).deleted_at, null);
});

test("Normal and trash account lists separate deletion state while preserving identity and profile fields", async () => {
  const current = await rawUser();
  const target = await rawUser({
    department: "Operations",
    job_title: "Reviewer",
  });
  const deleted = await setUserDeleted(actor, {
    id: target.id,
    version: target.version,
    deleted: true,
  });
  assert.equal(deleted.id, target.id);
  assert.equal(deleted.email, target.email);
  assert.equal(deleted.name, target.name);
  sanitized(deleted);
  const normal = await listUsers(actor);
  const trash = await listUsers(actor, true);
  assert.ok(normal.some((row) => row.id === current.id));
  assert.equal(
    normal.some((row) => row.id === target.id),
    false,
  );
  assert.equal(
    trash.some((row) => row.id === current.id),
    false,
  );
  const trashed = trash.find((row) => row.id === target.id);
  assert.ok(trashed);
  assert.equal(trashed.department, "Operations");
  assert.equal(trashed.job_title, "Reviewer");
  assert.equal(trashed.active, false);
  sanitized(trashed);
});

test("Account deletion revokes every session and preserves referenced work, documents, reports and audit history", async () => {
  const target = await rawUser({
    department: "Support",
    job_title: "Engineer",
  });
  const firstCookie = await createSession(target.id);
  const secondCookie = await createSession(target.id);
  const customerId = crypto.randomUUID(),
    siteId = crypto.randomUUID(),
    assetId = crypto.randomUUID(),
    inspectionId = crypto.randomUUID();
  const entryId = crypto.randomUUID(),
    documentId = crypto.randomUUID(),
    reportId = crypto.randomUUID(),
    auditId = crypto.randomUUID();
  const snapshot = {
    record: { name: "Historical visit", assignee_name: target.name },
    entries: [],
    documents: [],
    approved_name: target.name,
  };
  await db.query(
    "INSERT INTO customers(id,name) VALUES ($1,'Referenced customer')",
    [customerId],
  );
  await db.query(
    "INSERT INTO sites(id,customer_id,name) VALUES ($1,$2,'Referenced site')",
    [siteId, customerId],
  );
  await db.query(
    "INSERT INTO assets(id,site_id,name,product,owner_id) VALUES ($1,$2,'Referenced asset','Server',$3)",
    [assetId, siteId, target.id],
  );
  await db.query(
    "INSERT INTO inspections(id,asset_id,name,planned_date,assignee_id,status,result) VALUES ($1,$2,'Historical visit','2026-10-01',$3,'completed','Preserved result')",
    [inspectionId, assetId, target.id],
  );
  await db.query(
    "INSERT INTO entries(id,entity_kind,entity_id,user_id,body,evidence_level) VALUES ($1,'inspections',$2,$3,'Preserved work entry','observed')",
    [entryId, inspectionId, target.id],
  );
  await db.query(
    "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by) VALUES ($1,'inspections',$2,'Synthetic metadata only','text/plain',0,$1,$3)",
    [documentId, inspectionId, target.id],
  );
  await db.query(
    "INSERT INTO download_grants(id,user_id,document_id,reason,expires_at) VALUES ($1,$2,$3,'Synthetic download authorization',now()+interval '5 minutes')",
    [crypto.randomUUID(), target.id, documentId],
  );
  await db.query(
    "INSERT INTO reports(id,entity_kind,entity_id,revision,title,snapshot,approved_by) VALUES ($1,'inspections',$2,1,'Historical report',$3,$4)",
    [reportId, inspectionId, JSON.stringify(snapshot), target.id],
  );
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_kind,entity_id,details) VALUES ($1,$2,'synthetic_action','inspections',$3,'{}')",
    [auditId, target.id, inspectionId],
  );
  const deleted = await setUserDeleted(actor, {
    id: target.id,
    version: target.version,
    deleted: true,
  });
  assert.equal(deleted.active, false);
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by, actor.id);
  assert.equal(deleted.version, target.version + 1);
  assert.equal((await persisted(target.id)).password_hash, passwordHash);
  assert.deepEqual(await sessions(target.id), []);
  assert.equal(await resolveSession(firstCookie), null);
  assert.equal(await resolveSession(secondCookie), null);
  assert.deepEqual(
    await db.query("SELECT id FROM download_grants WHERE user_id=$1", [
      target.id,
    ]),
    [],
  );
  const [entry] = await db.query(
    "SELECT user_id,body FROM entries WHERE id=$1",
    [entryId],
  );
  assert.equal(entry.user_id, target.id);
  assert.equal(entry.body, "Preserved work entry");
  const [document] = await db.query(
    "SELECT uploaded_by,deleted_at FROM documents WHERE id=$1",
    [documentId],
  );
  assert.equal(document.uploaded_by, target.id);
  assert.equal(document.deleted_at, null);
  const [report] = await db.query(
    "SELECT approved_by,snapshot,withdrawn_at FROM reports WHERE id=$1",
    [reportId],
  );
  assert.equal(report.approved_by, target.id);
  assert.deepEqual(report.snapshot, snapshot);
  assert.equal(report.withdrawn_at, null);
  assert.ok(
    (
      await listReports(actor, new URLSearchParams({ entity_id: inspectionId }))
    ).rows.some((row) => row.id === reportId),
  );
  const detail = await details("inspections", inspectionId, actor);
  assert.equal(detail.record.assignee_id, target.id);
  assert.equal(detail.record.assignee_name, target.name);
  assert.ok(
    detail.entries.some(
      (row: Row) => row.id === entryId && row.body === "Preserved work entry",
    ),
  );
  const [audit] = await db.query("SELECT user_id FROM audit_logs WHERE id=$1", [
    auditId,
  ]);
  assert.equal(audit.user_id, target.id);
});

test("Restoring a deleted account leaves it inactive and never revives old sessions", async () => {
  const target = await rawUser({
    department: "Restore department",
    job_title: "Restore title",
  });
  const cookie = await createSession(target.id);
  const deleted = await setUserDeleted(actor, {
    id: target.id,
    version: target.version,
    deleted: true,
  });
  const restored = await setUserDeleted(actor, {
    id: target.id,
    version: deleted.version,
    deleted: false,
  });
  assert.equal(restored.id, target.id);
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.active, false);
  assert.equal(restored.email, target.email);
  assert.equal(restored.department, target.department);
  assert.equal(restored.job_title, target.job_title);
  assert.equal(restored.version, deleted.version + 1);
  assert.deepEqual(await sessions(target.id), []);
  assert.equal(await resolveSession(cookie), null);
  await assert.rejects(() => createSession(target.id), status(401));
  await assert.rejects(() => attemptLogin(target.email, password), status(401));
  assert.ok((await listUsers(actor)).some((row) => row.id === target.id));
  assert.equal(
    (await listUsers(actor, true)).some((row) => row.id === target.id),
    false,
  );
});

test("A deleted account cannot be modified or receive a session", async () => {
  const target = await rawUser();
  const deleted = await setUserDeleted(actor, {
    id: target.id,
    version: target.version,
    deleted: true,
  });
  await assert.rejects(
    () =>
      saveUser(
        actor,
        updateInput(deleted, { active: true, name: "Must not reactivate" }),
      ),
    status(410),
  );
  await assert.rejects(() => createSession(target.id), status(401));
  await assert.rejects(() => attemptLogin(target.email, password), status(401));
  const stored = await persisted(target.id);
  assert.equal(stored.name, target.name);
  assert.equal(stored.active, false);
  assert.deepEqual(await sessions(target.id), []);
});

test("Privacy-erased accounts cannot be restored, deleted, edited or authenticated", async () => {
  const target = await rawUser();
  const cookie = await createSession(target.id);
  // An erased flag must be authoritative even if an inconsistent import leaves active=true.
  await db.query("UPDATE users SET privacy_erased_at=now() WHERE id=$1", [
    target.id,
  ]);
  await assert.rejects(
    () =>
      saveUser(
        actor,
        updateInput(target, { name: "Must not restore erased identity" }),
      ),
    status(410),
  );
  for (const deleted of [true, false])
    await assert.rejects(
      () =>
        setUserDeleted(actor, {
          id: target.id,
          version: target.version,
          deleted,
        }),
      status(410),
    );
  await assert.rejects(() => createSession(target.id), status(401));
  await assert.rejects(() => attemptLogin(target.email, password), status(401));
  assert.equal(await resolveSession(cookie), null);
  assert.ok((await persisted(target.id)).privacy_erased_at);
  const listed = (await listUsers(actor)).find((row) => row.id === target.id);
  assert.ok(listed?.privacy_erased_at);
  sanitized(listed);
});

test("Deleting an account keeps its email reserved for restoration", async () => {
  const target = await rawUser();
  await setUserDeleted(actor, {
    id: target.id,
    version: target.version,
    deleted: true,
  });
  await assert.rejects(
    () => saveUser(actor, invite({ email: target.email.toUpperCase() })),
    status(409),
  );
  const rows = await db.query(
    "SELECT id FROM users WHERE lower(email)=lower($1)",
    [target.email],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [target.id],
  );
});

test("Stale versions cannot overwrite, delete or restore a changed account", async () => {
  const target = await rawUser();
  const updated = await saveUser(
    actor,
    updateInput(target, {
      name: "Current name",
      department: "Current department",
    }),
  );
  await assert.rejects(
    () => saveUser(actor, updateInput(target, { name: "Stale name" })),
    status(409),
  );
  await assert.rejects(
    () =>
      setUserDeleted(actor, {
        id: target.id,
        version: target.version,
        deleted: true,
      }),
    status(409),
  );
  const deleted = await setUserDeleted(actor, {
    id: target.id,
    version: updated.version,
    deleted: true,
  });
  await assert.rejects(
    () =>
      setUserDeleted(actor, {
        id: target.id,
        version: updated.version,
        deleted: false,
      }),
    status(409),
  );
  const stored = await persisted(target.id);
  assert.equal(stored.name, "Current name");
  assert.equal(stored.department, "Current department");
  assert.equal(stored.version, deleted.version);
  assert.ok(stored.deleted_at);
});

test("The current administrator cannot delete, disable or demote their own account", async () => {
  const current = await persisted(actor.id);
  await assert.rejects(
    () =>
      setUserDeleted(actor, {
        id: actor.id,
        version: current.version,
        deleted: true,
      }),
    status(400),
  );
  await assert.rejects(
    () => saveUser(actor, updateInput(current, { active: false })),
    status(400),
  );
  await assert.rejects(
    () => saveUser(actor, updateInput(current, { role: "engineer" })),
    status(400),
  );
  const stored = await persisted(actor.id);
  assert.equal(stored.active, true);
  assert.equal(stored.role, "admin");
  assert.equal(stored.deleted_at, null);
});

test("Concurrent administrators deleting each other leave one administrator and reject the stale actor", async () => {
  const first = await rawUser({ role: "admin" });
  const second = await rawUser({ role: "admin" });
  await db.query("UPDATE users SET active=false WHERE id=$1", [actor.id]);
  try {
    const results = await Promise.allSettled([
      setUserDeleted(first, {
        id: second.id,
        version: second.version,
        deleted: true,
      }),
      setUserDeleted(second, {
        id: first.id,
        version: first.version,
        deleted: true,
      }),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(status(403)(rejected.reason) || status(409)(rejected.reason));
    const survivors = await db.query(
      "SELECT id FROM users WHERE role='admin' AND active=true AND deleted_at IS NULL AND privacy_erased_at IS NULL",
    );
    assert.equal(survivors.length, 1);
    assert.ok([first.id, second.id].includes(survivors[0].id));
  } finally {
    await db.query("UPDATE users SET active=true WHERE id=$1", [actor.id]);
    await db.query("UPDATE users SET active=false WHERE id=ANY($1::text[])", [
      [first.id, second.id],
    ]);
  }
});

test("Session issuance racing with deletion cannot leave a usable session after deletion", async () => {
  for (const deleteFirst of [false, true]) {
    const target = await rawUser();
    const issue = () => createSession(target.id);
    const remove = () =>
      setUserDeleted(actor, {
        id: target.id,
        version: target.version,
        deleted: true,
      });
    const operations = deleteFirst ? [remove(), issue()] : [issue(), remove()];
    const results = await Promise.allSettled(operations);
    const deletion = results[deleteFirst ? 0 : 1];
    const issuance = results[deleteFirst ? 1 : 0];
    assert.equal(deletion.status, "fulfilled");
    if (issuance.status === "fulfilled")
      assert.equal(await resolveSession(issuance.value as string), null);
    else assert.ok(status(401)(issuance.reason));
    assert.deepEqual(await sessions(target.id), []);
    assert.equal((await persisted(target.id)).active, false);
  }
});

test("Concurrent save and delete requests using the same version cannot both succeed", async () => {
  const target = await rawUser();
  const [saving, deleting] = await Promise.allSettled([
    saveUser(actor, updateInput(target, { name: "Concurrent current name" })),
    setUserDeleted(actor, {
      id: target.id,
      version: target.version,
      deleted: true,
    }),
  ]);
  assert.equal(
    [saving, deleting].filter((result) => result.status === "fulfilled").length,
    1,
  );
  const stored = await persisted(target.id);
  assert.equal(stored.version, target.version + 1);
  if (saving.status === "fulfilled") {
    assert.equal(stored.name, "Concurrent current name");
    assert.equal(stored.deleted_at, null);
    assert.ok(deleting.status === "rejected" && status(409)(deleting.reason));
  } else {
    assert.ok(status(409)(saving.reason) || status(410)(saving.reason));
    assert.equal(stored.name, target.name);
    assert.ok(stored.deleted_at);
    assert.equal(stored.active, false);
  }
});

test("Active session resolution includes department and job title without credentials", async () => {
  const target = await rawUser({
    department: "Session department",
    job_title: "Session title",
  });
  const cookie = await createSession(target.id);
  const resolved = await resolveSession(cookie);
  assert.ok(resolved);
  assert.equal(resolved.id, target.id);
  assert.equal(resolved.department, "Session department");
  assert.equal(resolved.job_title, "Session title");
  sanitized(resolved);
});

test("The database prevents a deleted account from being active", async () => {
  const target = await rawUser();
  await assert.rejects(
    () =>
      db.query("UPDATE users SET deleted_at=now(),active=true WHERE id=$1", [
        target.id,
      ]),
    (error) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23514",
  );
  const stored = await persisted(target.id);
  assert.equal(stored.deleted_at, null);
  assert.equal(stored.active, true);
});
