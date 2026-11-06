import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { User } from "../src/lib/auth.ts";
import type { Database, Row } from "../src/lib/db.ts";
import { saveRecord, lookups } from "../src/lib/records.ts";
import { details } from "../src/lib/details.ts";
import { replayTombstones } from "../src/lib/privacy.ts";
import { AppError } from "../src/lib/policy.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let db: Database;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
const user: User = {
  id: crypto.randomUUID(),
  email: "contact-priority@example.test",
  name: "Synthetic admin",
  role: "admin",
  active: true,
};
const status = (n: number) => (e: unknown) =>
  e instanceof AppError && e.status === n;

before(async () => {
  fixture = await isolatedDatabase();
  db = fixture.db;
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'unused')",
    [user.id, user.email, user.name, user.role],
  );
});
after(async () => {
  await fixture?.close();
});

async function customer() {
  return saveRecord("customers", user, {
    name: "Synthetic " + crypto.randomUUID(),
  });
}
function contact(customerId: string, name: string, extra: Row = {}) {
  return saveRecord("customer_contacts", user, {
    customer_id: customerId,
    name,
    ...extra,
  });
}
function edit(row: Row, changes: Row, actor = user) {
  return saveRecord(
    "customer_contacts",
    actor,
    {
      customer_id: row.customer_id,
      name: row.name,
      status: row.status,
      version: row.version,
      ...changes,
    },
    row.id,
  );
}

test("migration is idempotent and database enforces one active primary", async () => {
  const sql = await readFile("db/009_contact_priority.sql", "utf8");
  await db.exec(sql);
  await db.exec(sql);
  const c = await customer();
  await contact(c.id, "First", { is_primary: true });
  const other = await contact(c.id, "Second");
  await assert.rejects(() =>
    db.query("UPDATE customer_contacts SET is_primary=true WHERE id=$1", [
      other.id,
    ]),
  );
});

test("primary switch is atomic, bumps prior version and rejects stale edits", async () => {
  const c = await customer();
  const first = await contact(c.id, "First", { is_primary: true });
  const second = await contact(c.id, "Second");
  await assert.rejects(
    () => edit(second, { is_primary: true, left_at: "2000-01-01" }),
    status(400),
  );
  const beforeSwitch = await db.query(
    "SELECT id FROM customer_contacts WHERE customer_id=$1 AND is_primary",
    [c.id],
  );
  assert.equal(beforeSwitch[0].id, first.id);
  await edit(second, { is_primary: true });
  const rows = await db.query(
    "SELECT id,is_primary,version FROM customer_contacts WHERE customer_id=$1 ORDER BY name",
    [c.id],
  );
  assert.equal(rows[0].is_primary, false);
  assert.equal(rows[0].version, first.version + 1);
  assert.equal(rows[1].is_primary, true);
  await assert.rejects(() => edit(first, { is_primary: true }), status(409));
  const unchanged = await db.query(
    "SELECT id FROM customer_contacts WHERE customer_id=$1 AND is_primary",
    [c.id],
  );
  assert.equal(unchanged[0].id, second.id);
});

test("departed contacts cannot be primary and are excluded from lookups", async () => {
  const c = await customer();
  await assert.rejects(
    () => contact(c.id, "Invalid", { is_primary: true, left_at: "2000-01-01" }),
    status(400),
  );
  const departed = await contact(c.id, "Departed unique " + c.id, {
    left_at: "2000-01-01",
  });
  const result = await lookups(
    new URLSearchParams({ entity: "customer_contacts", q: departed.name }),
    user,
  );
  assert.equal(result.customer_contacts.length, 0);
});

test("customer details sort primary then priority then name", async () => {
  const c = await customer();
  await contact(c.id, "Z", { is_primary: true });
  await contact(c.id, "B", { contact_priority: 2 });
  await contact(c.id, "A", { contact_priority: 2 });
  await contact(c.id, "C");
  const result = await details(
    "customers",
    c.id,
    user,
    new URLSearchParams({ section: "customer_contacts" }),
  );
  assert.deepEqual(
    result.related.customer_contacts.map((r) => r.name),
    ["Z", "A", "B", "C"],
  );
});

test("privacy recovery clears contact personal fields", async () => {
  const c = await customer();
  const row = await contact(c.id, "Synthetic contact", {
    job_title: "직책",
    left_at: "2000-01-01",
  });
  await replayTombstones([
    {
      id: crypto.randomUUID(),
      subject_kind: "customers",
      subject_id: c.id,
      request_id: crypto.randomUUID(),
      erased_at: new Date().toISOString(),
    },
  ]);
  const [erased] = await db.query(
    "SELECT job_title,left_at FROM customer_contacts WHERE id=$1",
    [row.id],
  );
  assert.equal(erased.job_title, null);
  assert.equal(erased.left_at, null);
});

test("viewer cannot modify contacts", async () => {
  const c = await customer();
  const row = await contact(c.id, "Synthetic contact");
  await assert.rejects(
    () => edit(row, { is_primary: true }, { ...user, role: "viewer" }),
    status(403),
  );
});
