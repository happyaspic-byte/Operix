import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { getDb, type Database } from "../src/lib/db.ts";
import {
  saveRecord,
  getRecord,
  listRecords,
  lookups,
} from "../src/lib/records.ts";
import {
  hashPassword,
  verifyPassword,
  createSession,
  resolveSession,
  revokeSession,
  type User,
  attemptLogin,
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
process.env.FILE_SCAN_MODE = "test";
let tempRoot: string;
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
  tempRoot = await mkdtemp("/tmp/operix-regression-");
  process.env.UPLOAD_DIR = tempRoot + "/uploads";
  process.env.SECURITY_LOG_DIR = tempRoot + "/security";
  db = await getDb();
  for (const name of (await readdir("db"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(await readFile("db/" + name, "utf8"));
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
  await rm(tempRoot, { recursive: true, force: true });
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

// Regression IDs map directly to the independent improvement review.
import {
  readJson,
  readLimited,
  readMultipart,
  pagination,
  queryDate,
  withUploadSlot,
} from "../src/lib/http.ts";
import {
  uploadDocument,
  listDocuments,
  downloadDocument,
  createDownloadGrant,
  documentPath,
} from "../src/lib/documents.ts";
import { createReport, getReport, listReports } from "../src/lib/reports.ts";
import { details } from "../src/lib/details.ts";
import { overview } from "../src/lib/overview.ts";
import {
  previewErasure,
  executeErasure,
  purgeDeletedFiles,
} from "../src/lib/privacy.ts";
import {
  securityLog,
  verifySecurityLines,
  trustedAddress,
} from "../src/lib/security.ts";
import { scanBytes } from "../src/lib/file-scanner.ts";
import { changePassword, handoff } from "../src/lib/account.ts";
const status = (n: number) => (e: unknown) =>
  e instanceof AppError && e.status === n;
async function fresh() {
  const c = await saveRecord("customers", user, {
      name: "Regression " + crypto.randomUUID(),
      contact_name: "Synthetic Contact",
      email: "contact@example.test",
      notes: "Synthetic private note",
    }),
    s = await saveRecord("sites", user, { name: "Site", customer_id: c.id }),
    a = await saveRecord("assets", user, {
      name: "Asset",
      site_id: s.id,
      product: "Server",
    });
  return { c, s, a };
}
function form(
  kind: string,
  id: string,
  name = "evidence.txt",
  content = "Synthetic verification evidence",
  classification = "internal",
) {
  const f = new FormData();
  f.set("entity_kind", kind);
  f.set("entity_id", id);
  f.set("classification", classification);
  f.set("file", new File([content], name));
  return f;
}
function update(kind: string, row: any, extra: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const f of catalog[kind].fields)
    if (f.key in row)
      data[f.key] =
        f.type === "select"
          ? String(row[f.key])
          : row[f.key] === null &&
              !["number", "date", "relation"].includes(f.type || "")
            ? ""
            : row[f.key];
  return saveRecord(
    kind,
    user,
    { ...data, ...extra, version: row.version },
    row.id,
  );
}
import { catalog } from "../src/lib/catalog.ts";
test("A01: financial attachment is absent from viewer lists/details and denied by direct download", async () => {
  const { c } = await fresh(),
    contract = await saveRecord("contracts", user, {
      customer_id: c.id,
      name: "Financial document test",
      kind: "maintenance",
      term: "unknown",
    }),
    doc = await uploadDocument(
      user,
      form(
        "contracts",
        contract.id,
        "pricing.txt",
        "Confidential price: 5000",
        "financial",
      ),
    );
  assert.equal(doc.scan_status, "clean");
  assert.equal(
    (
      await listDocuments(
        viewer,
        new URLSearchParams({ entity_id: contract.id }),
      )
    ).total,
    0,
  );
  assert.equal(
    (await details("contracts", contract.id, viewer)).documents.length,
    0,
  );
  await assert.rejects(
    () => downloadDocument(viewer, doc.id, new URLSearchParams()),
    status(403),
  );
});
test("A01/B02: sensitive download reason grants are user-bound and single use", async () => {
  const doc = await uploadDocument(
    user,
    form(
      "assets",
      asset.id,
      "network.txt",
      "Synthetic network record",
      "network",
    ),
  );
  await assert.rejects(
    () => downloadDocument(user, doc.id, new URLSearchParams()),
    status(403),
  );
  const grant = await createDownloadGrant(user, doc.id, "회귀 검증 자료 확인");
  const q = new URL(grant.url, "http://localhost").searchParams;
  const result = await downloadDocument(user, doc.id, q);
  assert.equal(
    await new Response(result.stream).text(),
    "Synthetic network record",
  );
  await assert.rejects(() => downloadDocument(user, doc.id, q), status(403));
});
test("A02: archiving an asset cancels scheduled instances and blocks all future generation", async () => {
  const { a } = await fresh();
  await saveRecord("maintenance_plans", user, {
    name: "Archived plan",
    asset_id: a.id,
    start_date: "2026-08-01",
    interval_months: "1",
  });
  await runJobs("2026-09-05");
  await update("assets", a, { status: "archived" });
  const [before] = await db.query(
    "SELECT count(*)::int n FROM inspections WHERE asset_id=$1",
    [a.id],
  );
  await runJobs("2027-09-05");
  const [after] = await db.query(
    "SELECT count(*)::int n FROM inspections WHERE asset_id=$1",
    [a.id],
  );
  assert.equal(after.n, before.n);
  assert.equal(
    (
      await db.query(
        "SELECT id FROM inspections WHERE asset_id=$1 AND status='scheduled'",
        [a.id],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT id FROM maintenance_plans WHERE asset_id=$1 AND status='active'",
        [a.id],
      )
    ).length,
    0,
  );
});
test("A02: archived customer prevents scheduler generation for its still-active assets", async () => {
  const { c, a } = await fresh();
  await saveRecord("maintenance_plans", user, {
    name: "Customer archived plan",
    asset_id: a.id,
    start_date: "2026-09-01",
    interval_months: "1",
  });
  await update("customers", c, { status: "archived" });
  await runJobs("2026-09-05");
  assert.equal(
    (await db.query("SELECT id FROM inspections WHERE asset_id=$1", [a.id]))
      .length,
    0,
  );
});
test("A03: generated plan cannot change assets while untouched plans may", async () => {
  const { a } = await fresh(),
    other = await fresh();
  let p = await saveRecord("maintenance_plans", user, {
    name: "Stable plan",
    asset_id: a.id,
    start_date: "2026-09-01",
    interval_months: "1",
  });
  await runJobs("2026-09-05");
  await assert.rejects(
    () => update("maintenance_plans", p, { asset_id: other.a.id }),
    status(409),
  );
  p = await saveRecord("maintenance_plans", user, {
    name: "Future plan",
    asset_id: a.id,
    start_date: "2090-01-01",
    interval_months: "1",
  });
  assert.equal(
    (await update("maintenance_plans", p, { asset_id: other.a.id })).asset_id,
    other.a.id,
  );
});
test("A04/C02: existing inactive assignee remains editable and discoverable but cannot receive new work", async () => {
  const uid = crypto.randomUUID();
  await db.query(
    "INSERT INTO users(id,name,email,role,password_hash) VALUES ($1,'Former engineer',$2,'engineer','disabled')",
    [uid, uid + "@example.test"],
  );
  let t = await saveRecord("tickets", user, {
    name: "Retained work",
    customer_id: customer.id,
    assignee_id: uid,
  });
  await db.query("UPDATE users SET active=false WHERE id=$1", [uid]);
  t = await update("tickets", t, { description: "History correction" });
  assert.equal(t.assignee_id, uid);
  const choices = await lookups(
    new URLSearchParams({ current_kind: "tickets", current_id: t.id }),
    user,
  );
  assert.equal(choices.users.find((u) => u.id === uid)?.status, "archived");
  await assert.rejects(
    () =>
      saveRecord("tickets", user, {
        name: "New work",
        customer_id: customer.id,
        assignee_id: uid,
      }),
    status(400),
  );
});
test("A04: retained archived linked assets are editable, new links are rejected", async () => {
  const { c, a } = await fresh();
  let t = await saveRecord("tickets", user, {
    name: "Retained asset",
    customer_id: c.id,
    asset_ids: [a.id],
  });
  await update("assets", a, { status: "archived" });
  t = await update("tickets", t, { description: "History correction" });
  assert.deepEqual(t.asset_ids, [a.id]);
  await assert.rejects(
    () =>
      saveRecord("tickets", user, {
        name: "New link",
        customer_id: c.id,
        asset_ids: [a.id],
      }),
    status(400),
  );
});
test("A05: JSON roots, invalid JSON and malformed UTF8 return client errors", async () => {
  for (const body of ["null", "[]", "1", "true", '"text"', "{"])
    await assert.rejects(
      () => readJson(new Request("http://localhost", { method: "POST", body })),
      status(400),
    );
  await assert.rejects(
    () =>
      readJson(
        new Request("http://localhost", {
          method: "POST",
          body: new Uint8Array([255]),
        }),
      ),
    status(400),
  );
  assert.deepEqual(
    await readJson(
      new Request("http://localhost", { method: "POST", body: "{}" }),
    ),
    {},
  );
});
test("A06: all invalid pagination values are rejected before SQL execution", async () => {
  for (const value of [
    "abc",
    "0",
    "-1",
    "1.5",
    "Infinity",
    "1e2",
    "9007199254740992",
    "",
  ])
    for (const key of ["page", "limit"])
      assert.throws(
        () => pagination(new URLSearchParams({ [key]: value })),
        status(400),
      );
  assert.deepEqual(
    pagination(new URLSearchParams({ page: "2", limit: "20" })),
    { page: 2, limit: 20, offset: 20 },
  );
  assert.throws(() => queryDate("2026-02-30"), status(400));
});
test("A08: viewer dashboard does not expose audit metadata", async () => {
  const d = await overview(viewer);
  assert.deepEqual(d.activity, []);
});
test("B05: headerless oversized chunks and slow bodies fail within bounded reads", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(6));
      c.enqueue(new Uint8Array(6));
      c.close();
    },
  });
  await assert.rejects(
    () =>
      readLimited(
        new Request("http://localhost", {
          method: "POST",
          body: stream,
          duplex: "half",
        } as RequestInit),
        10,
      ),
    status(413),
  );
  const slow = new ReadableStream({ start() {} });
  await assert.rejects(
    () =>
      readLimited(
        new Request("http://localhost", {
          method: "POST",
          body: slow,
          duplex: "half",
        } as RequestInit),
        10,
        10,
      ),
    status(408),
  );
});
test("B05: duplicate fields and multiple files are rejected before upload processing", async () => {
  const f = form("assets", asset.id);
  f.append("file", new File(["x"], "another.txt"));
  await assert.rejects(
    () =>
      readMultipart(
        new Request("http://localhost", { method: "POST", body: f }),
      ),
    status(400),
  );
});
test("B05: upload admission rejects excess concurrent parsers and releases slots", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slots = Array.from({ length: 4 }, () => withUploadSlot(() => gate));
  await assert.rejects(() => withUploadSlot(async () => true), status(429));
  release();
  await Promise.all(slots);
  assert.equal(await withUploadSlot(async () => true), true);
});
test("B06: unscanned and infected attachments cannot be downloaded", async () => {
  const doc = await uploadDocument(
    user,
    form("assets", asset.id, "test.txt", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"),
  );
  assert.equal(doc.scan_status, "infected");
  await assert.rejects(
    () => downloadDocument(user, doc.id, new URLSearchParams()),
    status(423),
  );
  await db.query("UPDATE documents SET scan_status='pending' WHERE id=$1", [
    doc.id,
  ]);
  await assert.rejects(
    () => downloadDocument(user, doc.id, new URLSearchParams()),
    status(423),
  );
});
test("B06: production URL forbids the test scanner", async () => {
  const url = process.env.APP_URL;
  try {
    process.env.APP_URL = "https://operix.example.test";
    assert.equal((await scanBytes(Buffer.from("safe"))).status, "error");
  } finally {
    if (url) process.env.APP_URL = url;
    else delete process.env.APP_URL;
  }
});
test("C01: document and detail pages retain exact counts beyond 100 records", async () => {
  const { c } = await fresh();
  for (let i = 0; i < 105; i++)
    await db.query(
      "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by,classification,scan_status) VALUES ($1,'customers',$2,$3,'text/plain',1,$1,$4,'internal','clean')",
      [
        crypto.randomUUID(),
        c.id,
        "Document " + String(i).padStart(3, "0"),
        user.id,
      ],
    );
  const page = await listDocuments(
    viewer,
    new URLSearchParams({ entity_id: c.id, page: "6" }),
  );
  assert.equal(page.total, 105);
  assert.equal(page.rows.length, 5);
  const d = await details(
    "customers",
    c.id,
    viewer,
    new URLSearchParams({ section: "documents", page: "6" }),
  );
  assert.equal(d.totals.documents, 105);
  assert.equal(d.documents.length, 5);
});
test("C09: customer report excludes internal records, private files and live source changes", async () => {
  const { c, a } = await fresh(),
    t = await saveRecord("tickets", user, {
      name: "Snapshot report",
      customer_id: c.id,
      status: "resolved",
      resolution: "Verified resolution",
      asset_ids: [a.id],
      evidence_level: "observed",
      description: "Internal request note",
    });
  await db.query(
    "INSERT INTO entries(id,entity_kind,entity_id,user_id,body,evidence_level,customer_visible) VALUES ($1,'tickets',$2,$3,'Internal hypothesis','internal',false),($4,'tickets',$2,$3,'Approved fact','observed',true)",
    [crypto.randomUUID(), t.id, user.id, crypto.randomUUID()],
  );
  const r = await createReport(user, {
    entity_kind: "tickets",
    entity_id: t.id,
    audience: "customer",
    issue_reason: "검증 완료 고객 제출",
  });
  const publicReport = await getReport(viewer, r.id);
  assert.equal(publicReport.snapshot.entries.length, 1);
  assert.equal(publicReport.snapshot.entries[0].body, "Approved fact");
  assert.equal(publicReport.snapshot.record.description, undefined);
  assert.match(publicReport.snapshot.record.asset_name, /Asset/);
  await update("tickets", t, { resolution: "Changed later" });
  assert.equal(
    (await getReport(viewer, r.id)).snapshot.record.resolution,
    "Verified resolution",
  );
  const internal = await createReport(user, {
    entity_kind: "tickets",
    entity_id: t.id,
    audience: "internal",
    issue_reason: "내부 검토 기록 확정",
  });
  await assert.rejects(() => getReport(viewer, internal.id), status(403));
  assert.equal(
    (await listReports(viewer, new URLSearchParams({ entity_id: t.id }))).total,
    1,
  );
});
test("B02: signed security journal detects modified records and ignores untrusted forwarded IP", async () => {
  await securityLog(user, {
    action: "regression_read",
    kind: "customers",
    ids: [customer.id],
  });
  const name = (await readdir(process.env.SECURITY_LOG_DIR!)).find((n) =>
      n.endsWith(".jsonl"),
    )!,
    content = await readFile(process.env.SECURITY_LOG_DIR + "/" + name, "utf8");
  assert.ok(verifySecurityLines(content).count > 0);
  assert.throws(
    () =>
      verifySecurityLines(content.replace("regression_read", "changed_action")),
    status(409),
  );
  const trust = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = "0";
  assert.equal(
    trustedAddress(
      new Headers({
        "x-forwarded-for": "203.0.113.9",
        "x-operix-client-ip": "203.0.113.9",
      }),
    ),
    "unknown",
  );
  process.env.TRUST_PROXY_HEADERS = "1";
  assert.equal(
    trustedAddress(new Headers({ "x-operix-client-ip": "203.0.113.9" })),
    "203.0.113.9",
  );
  if (trust) process.env.TRUST_PROXY_HEADERS = trust;
  else delete process.env.TRUST_PROXY_HEADERS;
});
test("B03: password change revokes all sessions and clears initial-password state", async () => {
  const u = {
      ...user,
      id: crypto.randomUUID(),
      email: crypto.randomUUID() + "@example.test",
    },
    old = "Test-only-old-password-123!";
  await db.query(
    "INSERT INTO users(id,name,email,role,password_hash,must_change_password) VALUES ($1,'Password fixture',$2,'engineer',$3,true)",
    [u.id, u.email, await hashPassword(old)],
  );
  const cookie = await createSession(u.id);
  assert.equal((await resolveSession(cookie))?.must_change_password, true);
  await changePassword(u, old, "Test-only-new-password-456!");
  assert.equal(await resolveSession(cookie), null);
  assert.equal(
    (
      await db.query("SELECT must_change_password FROM users WHERE id=$1", [
        u.id,
      ])
    )[0].must_change_password,
    false,
  );
});
test("B03: idle sessions cannot be revived", async () => {
  const cookie = await createSession(user.id);
  await db.query(
    "UPDATE sessions SET last_seen_at=now()-interval '9 hours' WHERE user_id=$1",
    [user.id],
  );
  assert.equal(await resolveSession(cookie), null);
});
test("B04: account-source throttling does not let one source lock out another", async () => {
  const before = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = "1";
  const email = crypto.randomUUID() + "@example.test",
    a = new Request("http://localhost", {
      headers: { "x-operix-client-ip": "192.0.2.55" },
    }),
    b = new Request("http://localhost", {
      headers: { "x-operix-client-ip": "192.0.2.56" },
    });
  for (let n = 0; n < 5; n++)
    await assert.rejects(() => attemptLogin(email, "wrong", a), status(401));
  await assert.rejects(() => attemptLogin(email, "wrong", a), status(429));
  await assert.rejects(() => attemptLogin(email, "wrong", b), status(401));
  if (before) process.env.TRUST_PROXY_HEADERS = before;
  else delete process.env.TRUST_PROXY_HEADERS;
});
test("B01: legal holds and stale inventories prevent erasure; approved run removes original and copied PII", async () => {
  const { c } = await fresh();
  await db.query(
    "UPDATE privacy_policies SET purpose='Synthetic verification',lawful_basis='Synthetic request',retention_days=30,approved_by=$1,approved_at=now() WHERE resource_kind='customers'",
    [user.id],
  );
  await update("customers", c, { status: "archived" });
  const hold = crypto.randomUUID();
  await db.query(
    "INSERT INTO privacy_holds(id,subject_kind,subject_id,reason,authority,created_by) VALUES ($1,'customers',$2,'Synthetic hold','Synthetic authority',$3)",
    [hold, c.id, user.id],
  );
  await assert.rejects(
    () =>
      previewErasure(
        user,
        "customers",
        c.id,
        "Synthetic reason",
        "Synthetic basis",
      ),
    status(409),
  );
  await db.query("UPDATE privacy_holds SET active=false WHERE id=$1", [hold]);
  const doc = await uploadDocument(
    user,
    form("customers", c.id, "contact.txt", "Synthetic personal copy"),
  );
  let preview = await previewErasure(
    user,
    "customers",
    c.id,
    "Synthetic reason",
    "Synthetic basis",
  );
  await db.query(
    "UPDATE customers SET notes='New copied information',version=version+1 WHERE id=$1",
    [c.id],
  );
  await assert.rejects(() => executeErasure(user, preview.id), status(409));
  preview = await previewErasure(
    user,
    "customers",
    c.id,
    "Synthetic reason",
    "Synthetic basis",
  );
  await executeErasure(user, preview.id);
  await purgeDeletedFiles();
  const [erased] = await db.query("SELECT * FROM customers WHERE id=$1", [
    c.id,
  ]);
  assert.equal(erased.email, "");
  assert.equal(erased.contact_name, "");
  assert.ok(erased.privacy_erased_at);
  await assert.rejects(() => readFile(documentPath(doc.id)), {
    code: "ENOENT",
  });
  await assert.rejects(
    () => downloadDocument(user, doc.id, new URLSearchParams()),
    status(410),
  );
  const [state] = await db.query(
    "SELECT state FROM privacy_requests WHERE id=$1",
    [preview.id],
  );
  assert.equal(state.state, "pending_backups");
  assert.equal(
    (
      await db.query(
        "SELECT id FROM audit_logs WHERE entity_id=$1 AND details::text LIKE '%Synthetic Contact%'",
        [c.id],
      )
    ).length,
    0,
  );
});
import {
  previewImport,
  commitImport,
  importMapping,
} from "../src/lib/imports.ts";
import { createFollowUp } from "../src/lib/workflow.ts";
test("C02: handoff changes open work and preserves completed history", async () => {
  const { c } = await fresh();
  const open = await saveRecord("tickets", user, {
      name: "Handoff open",
      customer_id: c.id,
      assignee_id: engineer.id,
    }),
    closed = await saveRecord("tickets", user, {
      name: "Handoff closed",
      customer_id: c.id,
      assignee_id: engineer.id,
      status: "closed",
      resolution: "Completed",
    });
  await handoff(user, engineer.id, user.id);
  assert.equal(
    (await getRecord("tickets", open.id, user)).assignee_id,
    user.id,
  );
  assert.equal(
    (await getRecord("tickets", closed.id, user)).assignee_id,
    engineer.id,
  );
});
test("C03: my-work and date filters return only matching rows", async () => {
  const { c } = await fresh();
  const t = await saveRecord("tickets", user, {
    name: "My unique filtered task",
    customer_id: c.id,
    assignee_id: engineer.id,
  });
  const mine = await listRecords(
    "tickets",
    engineer,
    new URLSearchParams({ q: t.name, mine: "1" }),
  );
  assert.equal(mine.total, 1);
  assert.equal(
    (
      await listRecords(
        "tickets",
        user,
        new URLSearchParams({ q: t.name, mine: "1" }),
      )
    ).total,
    0,
  );
  await assert.rejects(
    () =>
      listRecords("tickets", user, new URLSearchParams({ from: "2026-02-30" })),
    status(400),
  );
});
test("C04: multiple contacts retain roles and reject cross-customer site links", async () => {
  const { c, s } = await fresh(),
    other = await fresh();
  await saveRecord("customer_contacts", user, {
    customer_id: c.id,
    site_id: s.id,
    name: "Technical contact",
    contact_role: "technical",
    email: "tech@example.test",
  });
  await saveRecord("customer_contacts", user, {
    customer_id: c.id,
    name: "Billing contact",
    contact_role: "billing",
  });
  assert.equal(
    (await details("customers", c.id, user)).totals.customer_contacts,
    2,
  );
  await assert.rejects(
    () =>
      saveRecord("customer_contacts", user, {
        customer_id: c.id,
        site_id: other.s.id,
        name: "Wrong relation",
      }),
    status(400),
  );
});
test("C05: SLA targets are snapshotted and status timestamps are recorded", async () => {
  await db.query(
    "UPDATE sla_policies SET enabled=true,response_minutes=60,resolution_minutes=240 WHERE severity='high'",
  );
  const { c } = await fresh();
  let t = await saveRecord("tickets", user, {
    customer_id: c.id,
    name: "SLA test",
    severity: "high",
  });
  assert.equal(t.response_target_minutes, 60);
  assert.equal(t.first_response_at, null);
  await db.query(
    "UPDATE sla_policies SET response_minutes=120 WHERE severity='high'",
  );
  t = await update("tickets", t, { status: "in_progress" });
  assert.ok(t.first_response_at);
  assert.equal(t.response_target_minutes, 60);
  t = await update("tickets", t, {
    status: "resolved",
    resolution: "Verified",
  });
  assert.ok(t.resolved_at);
  assert.equal(
    (
      await db.query("SELECT id FROM work_status_history WHERE entity_id=$1", [
        t.id,
      ])
    ).length,
    3,
  );
  await db.query("UPDATE sla_policies SET enabled=false WHERE severity='high'");
});
test("C06: follow-up conversion is idempotent and linked to the originating inspection", async () => {
  const { a } = await fresh();
  const i = await saveRecord("inspections", user, {
    asset_id: a.id,
    name: "Follow-up inspection",
    planned_date: "2026-09-05",
    status: "completed",
    result: "Verified",
    follow_up: "Replace synthetic fan",
  });
  const [one, two] = await Promise.all([
    createFollowUp(user, i.id, "Synthetic follow up"),
    createFollowUp(user, i.id, "Synthetic follow up"),
  ]);
  assert.equal(one.id, two.id);
  const t = await getRecord("tickets", one.id, user);
  assert.deepEqual(t.asset_ids, [a.id]);
  assert.equal(t.description, "Replace synthetic fan");
});
test("C08: contract predecessors cannot cross customers or form cycles", async () => {
  const { c } = await fresh(),
    other = await fresh();
  let first = await saveRecord("contracts", user, {
    customer_id: c.id,
    name: "First term",
    kind: "maintenance",
    term: "unknown",
  });
  const second = await saveRecord("contracts", user, {
    customer_id: c.id,
    name: "Renewed term",
    kind: "maintenance",
    term: "unknown",
    predecessor_id: first.id,
    notice_days: 60,
  });
  assert.equal(second.predecessor_id, first.id);
  await assert.rejects(
    () => update("contracts", first, { predecessor_id: second.id }),
    status(400),
  );
  await assert.rejects(
    () =>
      saveRecord("contracts", user, {
        customer_id: other.c.id,
        name: "Wrong predecessor",
        kind: "maintenance",
        term: "unknown",
        predecessor_id: first.id,
      }),
    status(400),
  );
});
test("C10/B10: customer and site import resolves names, detects ambiguity and erases committed payloads", async () => {
  const name = "Import customer " + crypto.randomUUID();
  let p = await previewImport(
    user,
    "customers",
    new File(
      ["고객사명,고객 담당자\n" + name + ",Synthetic contact"],
      "customers.csv",
    ),
  );
  assert.equal(p.valid, true);
  await commitImport(user, p.batch_id);
  assert.deepEqual(
    (
      await db.query("SELECT payload FROM import_batches WHERE id=$1", [
        p.batch_id,
      ])
    )[0].payload,
    [],
  );
  p = await previewImport(
    user,
    "sites",
    new File(["고객사명,사업장명\n" + name + ",Import site"], "sites.csv"),
  );
  assert.equal(p.valid, true);
  await commitImport(user, p.batch_id);
  const [s] = await db.query("SELECT * FROM sites WHERE name=$1", [
    "Import site",
  ]);
  assert.ok(s.customer_id);
  await saveRecord("customers", user, { name });
  p = await previewImport(
    user,
    "sites",
    new File(["고객사명,사업장명\n" + name + ",Ambiguous site"], "sites.csv"),
  );
  assert.equal(p.valid, false);
});
test("B03: background polling does not renew idle sessions", async () => {
  const cookie = await createSession(user.id);
  const [s] = await db.query(
    "SELECT id FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
    [user.id],
  );
  await db.query(
    "UPDATE sessions SET last_seen_at=now()-interval '10 minutes' WHERE id=$1",
    [s.id],
  );
  const [before] = await db.query(
    "SELECT last_seen_at FROM sessions WHERE id=$1",
    [s.id],
  );
  assert.ok(await resolveSession(cookie, false));
  const [after] = await db.query(
    "SELECT last_seen_at FROM sessions WHERE id=$1",
    [s.id],
  );
  assert.equal(after.last_seen_at, before.last_seen_at);
});
import { persistTombstone, readTombstones } from "../src/lib/privacy-ledger.ts";
test("B01: signed erasure intent remains available without application DB rows", async () => {
  const t = {
    id: crypto.randomUUID(),
    subject_kind: "customers" as const,
    subject_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    erased_at: new Date().toISOString(),
  };
  await persistTombstone(t);
  assert.deepEqual(
    (await readTombstones()).find((r) => r.id === t.id),
    t,
  );
});
test("Relation concurrency: asset move and contract link cannot both create inconsistent ownership", async () => {
  const { c, a } = await fresh(),
    other = await fresh();
  const results = await Promise.allSettled([
    saveRecord("contracts", user, {
      name: "Concurrent link",
      customer_id: c.id,
      kind: "maintenance",
      term: "unknown",
      asset_ids: [a.id],
    }),
    update("assets", a, { site_id: other.s.id }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const invalid = await db.query(
    "SELECT ca.asset_id FROM contract_assets ca JOIN contracts c ON c.id=ca.contract_id JOIN assets a ON a.id=ca.asset_id JOIN sites s ON s.id=a.site_id WHERE a.id=$1 AND c.customer_id<>s.customer_id",
    [a.id],
  );
  assert.equal(invalid.length, 0);
});
test("Worker concurrency: overlapping jobs generate no duplicate plan occurrences", async () => {
  const { a } = await fresh();
  const p = await saveRecord("maintenance_plans", user, {
    name: "Concurrent scheduler",
    asset_id: a.id,
    start_date: "2026-09-01",
    interval_months: "1",
  });
  await Promise.all([runJobs("2026-09-05"), runJobs("2026-09-05")]);
  const [c] = await db.query(
    "SELECT count(*)::int n,count(DISTINCT planned_date)::int distinct_n FROM inspections WHERE plan_id=$1",
    [p.id],
  );
  assert.ok(c.n > 0);
  assert.equal(c.n, c.distinct_n);
});
test("C11: bounded lookup and filtered query benchmark on 1000 synthetic assets", async () => {
  const { s } = await fresh(),
    prefix = "PERF-" + crypto.randomUUID();
  await db.query(
    "INSERT INTO assets(id,site_id,name,asset_tag,product) SELECT gen_random_uuid()::text,$1,$2||'-'||g,$2||'-'||g,'Server' FROM generate_series(1,1000) g",
    [s.id, prefix],
  );
  const values: number[] = [];
  for (let n = 0; n < 20; n++) {
    const start = performance.now();
    const r = await listRecords(
      "assets",
      user,
      new URLSearchParams({ q: prefix, page: "10", limit: "20" }),
    );
    assert.equal(r.total, 1000);
    assert.equal(r.rows.length, 20);
    values.push(performance.now() - start);
  }
  const choices = await lookups(
    new URLSearchParams({ entity: "assets", q: prefix }),
    user,
  );
  assert.equal(choices.assets.length, 100);
  values.sort((a, b) => a - b);
  const result = {
    engine: process.env.TEST_DATABASE_URL ? "PostgreSQL" : "PGlite",
    synthetic_assets: 1000,
    samples: 20,
    p95_ms: Number(values[18].toFixed(2)),
    max_ms: Number(values[19].toFixed(2)),
    scope:
      "Warm sequential service queries; not a production capacity guarantee",
  };
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(".data", { recursive: true });
  await writeFile(".data/performance.json", JSON.stringify(result, null, 2));
  console.log("PERFORMANCE " + JSON.stringify(result));
  assert.ok(
    values[19] < 5000,
    "Synthetic filtered query exceeded the regression budget",
  );
});

test("C10: standard XLSX asset template accepts blank optional selections", async () => {
  const { s } = await fresh();
  const bytes = await workbookBytes(
    [
      {
        site_id: s.id,
        name: "Template asset",
        product: "Server",
        asset_tag: "TPL-" + crypto.randomUUID(),
        status: "unknown",
        protection: "unknown",
      },
    ],
    Object.entries(importMapping("assets")),
  );
  const preview = await previewImport(
    user,
    "assets",
    new File([bytes], "template.xlsx"),
  );
  assert.equal(preview.valid, true, JSON.stringify(preview.rows));
  await commitImport(user, preview.batch_id);
  const rows = await db.query(
    "SELECT lifecycle_status FROM assets WHERE site_id=$1 AND name='Template asset'",
    [s.id],
  );
  assert.equal(rows[0].lifecycle_status, "operating");
});
