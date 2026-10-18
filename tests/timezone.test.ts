import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { DB_TIME_ZONE, withSessionTimeZone } from "../src/lib/db.ts";
import { saveRecord, listRecords } from "../src/lib/records.ts";
import { createReport, reportDocumentNumber } from "../src/lib/reports.ts";
import { addDays, todayKST } from "../src/lib/dates.ts";
import type { User } from "../src/lib/auth.ts";

const admin: User = {
  id: crypto.randomUUID(),
  email: "timezone@operix.test",
  name: "Timezone administrator",
  role: "admin",
  active: true,
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  isolated = await isolatedDatabase();
  await isolated.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,'unused')",
    [admin.id, admin.email, admin.name, admin.role],
  );
});
after(async () => isolated?.close());

const bareUrl = "postgresql://u:p@db:5432/operix";
const urlWithOptions =
  "postgresql://u:p@db:5432/operix?options=-c%20search_path%3Dtest_schema&sslmode=disable";

test("the Asia/Seoul session option is added to a URL without options", () => {
  assert.equal(DB_TIME_ZONE, "Asia/Seoul");
  assert.equal(
    new URL(withSessionTimeZone(bareUrl)).searchParams.get("options"),
    "-c TimeZone=Asia/Seoul",
  );
});

test("the Asia/Seoul session option keeps existing options and parameters", () => {
  const url = new URL(withSessionTimeZone(urlWithOptions));
  assert.equal(
    url.searchParams.get("options"),
    "-c search_path=test_schema -c TimeZone=Asia/Seoul",
  );
  assert.equal(url.searchParams.get("sslmode"), "disable");
});

test("applying the Asia/Seoul session option twice changes nothing", () => {
  for (const connectionString of [bareUrl, urlWithOptions]) {
    const once = withSessionTimeZone(connectionString);
    assert.equal(withSessionTimeZone(once), once);
  }
});

test("an invalid connection URL is rejected without echoing its password", () => {
  assert.throws(
    () => withSessionTimeZone("postgresql://u:sup3r-secret@db:notaport/operix"),
    (error) =>
      error instanceof Error && !inspect(error).includes("sup3r-secret"),
  );
});

test("the database session time zone is Asia/Seoul", async () => {
  const [row] = await isolated.db.query(
    "SELECT current_setting('TimeZone') value",
  );
  assert.equal(row.value, "Asia/Seoul");
});

test("a timestamp casts to its KST calendar date", async () => {
  const [row] = await isolated.db.query(
    "SELECT (TIMESTAMPTZ '2026-10-18 15:30:00+00')::date::text value",
  );
  assert.equal(row.value, "2026-10-19");
});

test("CURRENT_DATE is today in KST", async () => {
  const [row] = await isolated.db.query("SELECT CURRENT_DATE::text value");
  assert.equal(row.value, todayKST());
});

test("a contract that ended yesterday in KST is overdue, not expiring within 30 days", async () => {
  const customer = await saveRecord("customers", admin, {
    name: "Timezone customer " + crypto.randomUUID(),
  });
  const contract = await saveRecord("contracts", admin, {
    customer_id: customer.id,
    name: "Ended yesterday",
    kind: "maintenance",
    term: "dated",
    end_date: addDays(todayKST(), -1),
  });
  const listed = async (query: string) =>
    (
      await listRecords("contracts", admin, new URLSearchParams(query))
    ).rows.map((row) => row.id);
  assert.ok((await listed("expiry=overdue")).includes(contract.id));
  assert.ok(!(await listed("expiry=30")).includes(contract.id));
});

test("report document numbers carry the KST date and the id prefix", () => {
  const id = "abcdef12-3456-4789-8abc-def012345678";
  assert.equal(reportDocumentNumber(id, "2026-10-19"), "OPX-20261019-ABCDEF12");
  assert.equal(
    reportDocumentNumber(id),
    `OPX-${todayKST().replaceAll("-", "")}-ABCDEF12`,
  );
});

test("a confirmed report is numbered with today's KST date", async () => {
  const customer = await saveRecord("customers", admin, {
    name: "Report customer " + crypto.randomUUID(),
  });
  const site = await saveRecord("sites", admin, {
    name: "Report site",
    customer_id: customer.id,
  });
  const asset = await saveRecord("assets", admin, {
    name: "Report asset",
    site_id: site.id,
    product: "Server",
  });
  const ticket = await saveRecord("tickets", admin, {
    name: "Resolved ticket",
    customer_id: customer.id,
    asset_ids: [asset.id],
    status: "resolved",
    resolution: "Synthetic resolution",
  });
  const report = await createReport(admin, {
    entity_kind: "tickets",
    entity_id: ticket.id,
    issue_reason: "Time zone verification",
  });
  assert.match(
    report.document_number,
    new RegExp(`^OPX-${todayKST().replaceAll("-", "")}-[0-9A-F]{8}$`),
  );
});
