import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDb, type Database } from "../src/lib/db.ts";
import { saveRecord, getRecord } from "../src/lib/records.ts";
import {
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  revokeSession,
  type User,
} from "../src/lib/auth.ts";
import { can, redact, AppError } from "../src/lib/policy.ts";
import {
  dayDiff,
  expiryLabel,
  recurringDate,
  todayKST,
  validDate,
  formatDate,
} from "../src/lib/dates.ts";
import { validateEntity } from "../src/lib/validation.ts";
import { runJobs } from "../src/lib/jobs.ts";
import {
  safeCsv,
  parseSheet,
  workbookBytes,
  guardSpreadsheetArchive,
} from "../src/lib/sheets.ts";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "";
process.env.OPERIX_EMBEDDED = "1";
process.env.PGLITE_PATH = "memory://";
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ||
  "test-only-session-secret-with-at-least-32-characters";
let db: Database, customer: any, site: any, asset: any;
const user: User = {
  id: crypto.randomUUID(),
  email: "test-admin-" + Date.now() + "@example.com",
  name: "Test admin",
  role: "admin",
  active: true,
};
const engineer: User = {
  id: crypto.randomUUID(),
  email: "test-engineer-" + Date.now() + "@example.com",
  name: "Test engineer",
  role: "engineer",
  active: true,
};
const viewer: User = { ...user, role: "viewer" };
before(async () => {
  db = await getDb();
  await db.exec(await readFile("db/001_initial.sql", "utf8"));
  for (const u of [user, engineer])
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test-not-a-login-hash')",
      [u.id, u.email, u.name, u.role],
    );
  customer = await saveRecord("customers", user, {
    name: "Test customer " + Date.now(),
  });
  site = await saveRecord("sites", user, {
    customer_id: customer.id,
    name: "Site",
  });
  asset = await saveRecord("assets", user, {
    site_id: site.id,
    name: "Test system",
    asset_tag: "TEST-" + crypto.randomUUID(),
    product: "everRun",
    status: "unknown",
  });
});
after(async () => {
  await db.close();
});
test("KST midnight crosses the UTC date correctly", () => {
  assert.equal(todayKST(new Date("2026-09-04T15:01:00Z")), "2026-09-05");
});
test("Calendar validation rejects nonexistent dates", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2028-02-29"), true);
  assert.equal(validDate("2026-13-01"), false);
});
test("Timestamp display follows KST while calendar dates stay unchanged", () => {
  assert.equal(formatDate("2026-09-04T21:00:00Z"), "2026.09.05");
  assert.equal(formatDate("2026-09-04"), "2026.09.04");
  assert.equal(formatDate(null), "—");
});
test("Monthly recurrence retains the original month-end anchor", () => {
  assert.equal(recurringDate("2026-01-31", 1, 1), "2026-02-28");
  assert.equal(recurringDate("2026-01-31", 1, 2), "2026-03-31");
  assert.equal(recurringDate("2024-02-29", 12, 1), "2025-02-28");
});
test("Expired, expiry today, perpetual and unknown are distinct", () => {
  assert.equal(expiryLabel("2026-09-01", "dated", "2026-09-02").label, "만료");
  assert.equal(
    expiryLabel("2026-09-02", "dated", "2026-09-02").label,
    "오늘 만료",
  );
  assert.equal(expiryLabel(null, "perpetual").label, "무기한");
  assert.equal(expiryLabel(null, "unknown").label, "미확인");
  assert.equal(dayDiff("2026-10-01", "2026-09-01"), 30);
});
test("Roles protect money, networks and exports independently", () => {
  assert.equal(can("engineer", "network"), true);
  assert.equal(can("engineer", "money"), false);
  assert.equal(can("sales", "money"), true);
  assert.equal(can("sales", "network"), false);
  assert.equal(can("viewer", "export"), false);
});
test("Redaction removes sensitive columns without mutating original", () => {
  const row = {
    name: "A",
    management_ip: "192.0.2.1",
    network_notes: "private",
    amount: 5000,
  };
  const clean = redact(row, "viewer");
  assert.equal(clean.management_ip, undefined);
  assert.equal(clean.amount, undefined);
  assert.equal(row.amount, 5000);
});
test("Password hashing uses salted verification", async () => {
  const hash = await hashPassword("Test-only-password-123!");
  assert.notEqual(hash, "Test-only-password-123!");
  assert.equal(await verifyPassword("Test-only-password-123!", hash), true);
  assert.equal(await verifyPassword("incorrect", hash), false);
});
test("Opaque sessions are revoked on logout", async () => {
  const sealed = await createSession(user.id);
  assert.equal((await resolveSession(sealed))?.id, user.id);
  await revokeSession(sealed);
  assert.equal(await resolveSession(sealed), null);
});
test("Disabled user cannot use an existing session", async () => {
  const sealed = await createSession(user.id);
  await db.query("UPDATE users SET active=false WHERE id=$1", [user.id]);
  assert.equal(await resolveSession(sealed), null);
  await db.query("UPDATE users SET active=true WHERE id=$1", [user.id]);
});
test("Viewer mutation is rejected by the server service", async () => {
  await assert.rejects(
    () => saveRecord("assets", viewer, { name: "x" }),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("Case-insensitive asset identifiers cannot be duplicated", async () => {
  await assert.rejects(
    () =>
      saveRecord("assets", user, {
        site_id: site.id,
        name: "Duplicate",
        asset_tag: asset.asset_tag.toLowerCase(),
        product: "Server",
      }),
    (e: any) => e.code === "23505",
  );
});
test("Cross-customer contract asset link is rejected atomically", async () => {
  const c = await saveRecord("customers", user, { name: "Other customer" });
  await assert.rejects(
    () =>
      saveRecord("contracts", user, {
        customer_id: c.id,
        name: "Invalid",
        kind: "maintenance",
        term: "unknown",
        asset_ids: [asset.id],
      }),
    (e) => e instanceof AppError && e.status === 400,
  );
  const rows = await db.query("SELECT id FROM contracts WHERE name='Invalid'");
  assert.equal(rows.length, 0);
});
test("A contract can cover multiple assets", async () => {
  const second = await saveRecord("assets", user, {
    site_id: site.id,
    name: "Second",
    product: "Server",
  });
  const c = await saveRecord("contracts", user, {
    customer_id: customer.id,
    name: "Multi-asset support",
    kind: "vendor_support",
    term: "dated",
    end_date: "2026-12-31",
    asset_ids: [asset.id, second.id],
  });
  assert.equal(c.asset_ids.length, 2);
});
test("Contract dates cannot be reversed", () => {
  assert.throws(
    () =>
      validateEntity("contracts", {
        customer_id: customer.id,
        name: "x",
        kind: "license",
        term: "dated",
        start_date: "2026-12-31",
        end_date: "2026-01-01",
      }),
    AppError,
  );
});
test("Dated contract requires an end date", () => {
  assert.throws(
    () =>
      validateEntity("contracts", {
        customer_id: customer.id,
        name: "x",
        kind: "license",
        term: "dated",
      }),
    AppError,
  );
});
test("Stale edits cannot overwrite newer data", async () => {
  const original = await getRecord("customers", customer.id, user);
  const payload = {
    name: original.name,
    industry: "updated",
    version: original.version,
  };
  await saveRecord("customers", user, payload, customer.id);
  await assert.rejects(
    () =>
      saveRecord(
        "customers",
        user,
        { ...payload, industry: "stale" },
        customer.id,
      ),
    (e) => e instanceof AppError && e.status === 409,
  );
  assert.equal(
    (await getRecord("customers", customer.id, user)).industry,
    "updated",
  );
});
test("Engineer cannot reassign work to another employee", async () => {
  await assert.rejects(
    () =>
      saveRecord("tickets", engineer, {
        customer_id: customer.id,
        name: "Task",
        assignee_id: user.id,
      }),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("Engineer cannot submit unauthorized money fields", async () => {
  await assert.rejects(
    () => saveRecord("contracts", engineer, {}),
    (e) => e instanceof AppError && e.status === 403,
  );
});
test("Inspection completion requires every checklist item and result", () => {
  assert.throws(
    () =>
      validateEntity("inspections", {
        asset_id: asset.id,
        name: "Check",
        planned_date: "2026-09-01",
        status: "completed",
        result: "done",
        checklist: [{ label: "Storage", checked: false }],
      }),
    AppError,
  );
  assert.throws(
    () =>
      validateEntity("inspections", {
        asset_id: asset.id,
        name: "Check",
        planned_date: "2026-09-01",
        status: "completed",
      }),
    AppError,
  );
});
test("Ticket resolution requires a written outcome", () => {
  assert.throws(
    () =>
      validateEntity("tickets", {
        customer_id: customer.id,
        name: "Incident",
        status: "resolved",
      }),
    AppError,
  );
});
test("Invalid product codes and zero CPU are rejected", () => {
  assert.throws(
    () =>
      validateEntity("assets", {
        site_id: site.id,
        name: "x",
        product: "unsupported",
      }),
    AppError,
  );
  assert.throws(
    () =>
      validateEntity("vms", {
        asset_id: asset.id,
        name: "vm",
        vcpu: 0,
        memory_gb: 1,
        disk_gb: 1,
      }),
    AppError,
  );
});
test("Plan generation is idempotent and retains month-end dates", async () => {
  const plan = await saveRecord("maintenance_plans", user, {
    asset_id: asset.id,
    name: "Recurring",
    start_date: "2026-01-31",
    interval_months: "1",
    assignee_id: user.id,
    checklist: [{ label: "Check", checked: false }],
  });
  await runJobs("2026-03-01");
  const first = await db.query(
    "SELECT planned_date FROM inspections WHERE plan_id=$1 ORDER BY planned_date",
    [plan.id],
  );
  await runJobs("2026-03-01");
  const second = await db.query(
    "SELECT planned_date FROM inspections WHERE plan_id=$1 ORDER BY planned_date",
    [plan.id],
  );
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((r) => r.planned_date),
    ["2026-01-31", "2026-02-28", "2026-03-31"],
  );
});
test("Expiry notifications do not duplicate on repeated jobs", async () => {
  const c = await saveRecord("contracts", user, {
    customer_id: customer.id,
    name: "Expiry notice",
    kind: "maintenance",
    term: "dated",
    end_date: "2026-04-10",
    owner_id: user.id,
  });
  await runJobs("2026-04-01");
  const a = await db.query("SELECT id FROM notifications WHERE source_id=$1", [
    c.id,
  ]);
  await runJobs("2026-04-01");
  const b = await db.query("SELECT id FROM notifications WHERE source_id=$1", [
    c.id,
  ]);
  assert.ok(a.length > 0);
  assert.equal(a.length, b.length);
});
test("CSV cells are protected against formula injection", () => {
  assert.equal(safeCsv('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.ok(safeCsv(" @SUM(1)").startsWith("\"'"));
  assert.equal(safeCsv("normal"), '"normal"');
});
test("XLSX rejects oversized expansion and malformed archives before parsing", () => {
  const bytes = Buffer.alloc(68);
  bytes.writeUInt32LE(0x02014b50, 0);
  bytes.writeUInt32LE(33 * 1024 * 1024, 24);
  bytes.writeUInt32LE(0x06054b50, 46);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(0, 62);
  assert.throws(
    () => guardSpreadsheetArchive(bytes),
    (e) => e instanceof AppError && e.status === 413,
  );
  assert.throws(
    () => guardSpreadsheetArchive(Buffer.from("not a ZIP")),
    (e) => e instanceof AppError && e.status === 400,
  );
});
test("XLSX export/import preserves Korean text", async () => {
  const bytes = await workbookBytes(
    [{ name: "한글 자산", product: "everRun" }],
    [
      ["name", "자산명"],
      ["product", "제품"],
    ],
  );
  const rows = await parseSheet(
    new File([new Uint8Array(bytes)], "roundtrip.xlsx"),
  );
  assert.equal(rows[0]["자산명"], "한글 자산");
  assert.equal(rows[0]["제품"], "everRun");
});
test("Transactions roll back a partially written batch", async () => {
  const marker = crypto.randomUUID();
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await tx.query("INSERT INTO customers(id,name) VALUES ($1,'rollback')", [
        marker,
      ]);
      throw new Error("rollback");
    }),
  );
  assert.equal(
    (await db.query("SELECT id FROM customers WHERE id=$1", [marker])).length,
    0,
  );
});
