import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import {
  applySessionTimeZone,
  DB_TIME_ZONE,
  poolConfig,
} from "../src/lib/db.ts";
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

const malformedEscapeUrl = "postgresql://operix:p%ssw0rd!@db:5432/operix";
const urlWithOptions =
  "postgresql://u:p@db:5432/operix?options=-c%20search_path%3Dtest_schema&sslmode=disable";

test("the session time zone is set with one Asia/Seoul statement", async () => {
  const sent: string[] = [];
  await applySessionTimeZone({
    query: async (sql) => {
      sent.push(sql);
    },
  });
  assert.equal(DB_TIME_ZONE, "Asia/Seoul");
  assert.deepEqual(sent, ["SET TIME ZONE 'Asia/Seoul'"]);
});

test("the pool config sets the Asia/Seoul session on connect and leaves the connection string alone", () => {
  for (const [connectionString, password, options] of [
    [malformedEscapeUrl, "p%ssw0rd!", undefined],
    [urlWithOptions, "p", "-c search_path=test_schema"],
  ] as const) {
    assert.deepEqual(poolConfig(connectionString), {
      connectionString,
      max: 8,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 30000,
      query_timeout: 35000,
      onConnect: applySessionTimeZone,
    });
    // What pg makes of it: the password stays whole and the URL's own options
    // are the only ones sent.
    const parameters = (new Client(poolConfig(connectionString)) as any)
      .connectionParameters;
    assert.equal(parameters.password, password);
    assert.equal(parameters.options, options);
  }
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
