import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { type User } from "../src/lib/auth.ts";
import { saveRecord, getRecord } from "../src/lib/records.ts";
import { details } from "../src/lib/details.ts";
import { createReport, getReport } from "../src/lib/reports.ts";
import { createFollowUp } from "../src/lib/workflow.ts";
import { overview } from "../src/lib/overview.ts";
import { inventory } from "../src/lib/privacy.ts";

const user: User = {
  id: crypto.randomUUID(),
  email: "inspection-flows@operix.test",
  name: "Inspection flow administrator",
  role: "admin",
  active: true,
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  isolated = await isolatedDatabase();
  await isolated.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,'admin','not-a-login-hash')",
    [user.id, user.email, user.name],
  );
});
after(async () => isolated?.close());

async function fixture() {
  const customer = await saveRecord("customers", user, {
    name: "Inspection customer " + crypto.randomUUID(),
  });
  const site = await saveRecord("sites", user, {
    name: "Inspection site",
    customer_id: customer.id,
  });
  const first = await saveRecord("assets", user, {
    name: "APPDB Alpha",
    asset_tag: "FLOW-A-" + crypto.randomUUID(),
    site_id: site.id,
  });
  const second = await saveRecord("assets", user, {
    name: "APPDB Beta",
    asset_tag: "FLOW-B-" + crypto.randomUUID(),
    site_id: site.id,
  });
  const input = {
    name: "One customer visit",
    planned_date: "2026-09-10",
    asset_ids: [first.id, second.id],
  };
  return { customer, site, first, second, input };
}

test("one inspection is visible from every target asset and lists both related assets", async () => {
  const f = await fixture();
  const inspection = await saveRecord("inspections", user, f.input);
  const second = await details("assets", f.second.id, user);
  assert.equal(second.totals.inspections, 1);
  assert.equal(second.related.inspections[0].id, inspection.id);
  const first = await details("assets", f.first.id, user);
  assert.equal(first.totals.inspections, 1);
  const detail = await details("inspections", inspection.id, user);
  assert.equal(detail.totals.assets, 2);
  assert.deepEqual(
    new Set(detail.related.assets.map((asset) => asset.id)),
    new Set([f.first.id, f.second.id]),
  );
});

test("approved reports retain every target name and tag after the inspection is edited", async () => {
  const f = await fixture();
  const input = {
    ...f.input,
    status: "completed",
    result: "Both servers checked",
  };
  const inspection = await saveRecord("inspections", user, input);
  const report = await createReport(user, {
    entity_kind: "inspections",
    entity_id: inspection.id,
    audience: "customer",
    issue_reason: "Customer visit report verification",
  });
  const frozen = (await getReport(user, report.id)).snapshot.record;
  for (const value of [
    "APPDB Alpha",
    "APPDB Beta",
    f.first.asset_tag,
    f.second.asset_tag,
  ])
    assert.ok(frozen.asset_name.includes(value));
  assert.equal(frozen.customer_name, f.customer.name);
  assert.equal(frozen.follow_up, undefined);
  await saveRecord(
    "inspections",
    user,
    {
      ...input,
      asset_ids: [f.first.id],
      version: inspection.version,
    },
    inspection.id,
  );
  assert.deepEqual((await getReport(user, report.id)).snapshot.record, frozen);
  assert.equal(
    (await getRecord("inspections", inspection.id, user)).asset_ids.length,
    1,
  );
});

test("follow-up conversion carries all inspection targets and remains idempotent", async () => {
  const f = await fixture();
  const inspection = await saveRecord("inspections", user, {
    ...f.input,
    status: "completed",
    result: "Checked both servers",
    follow_up: "Review redundancy on both servers",
  });
  const ticket = await createFollowUp(
    user,
    inspection.id,
    "One follow-up task",
  );
  const record = await getRecord("tickets", ticket.id, user);
  assert.equal(record.customer_id, f.customer.id);
  assert.deepEqual(
    new Set(record.asset_ids),
    new Set([f.first.id, f.second.id]),
  );
  assert.equal(
    (await createFollowUp(user, inspection.id, "Retry")).id,
    ticket.id,
  );
});

test("dashboard shows all targets without multiplying the customer visit", async () => {
  const f = await fixture();
  const inspection = await saveRecord("inspections", user, {
    ...f.input,
    planned_date: "1900-01-01",
  });
  const summary = await overview(user);
  const rows = summary.inspections.filter((row) => row.id === inspection.id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].asset_name.includes("APPDB Alpha"));
  assert.ok(rows[0].asset_name.includes("APPDB Beta"));
});

test("privacy review includes the multi-asset inspection and detects changed target links", async () => {
  const f = await fixture();
  const inspection = await saveRecord("inspections", user, f.input);
  const before = await inventory(isolated.db, "customers", f.customer.id);
  assert.deepEqual(before.scope.inspections, [inspection.id]);
  await isolated.db.query(
    "DELETE FROM inspection_assets WHERE inspection_id=$1 AND asset_id=$2",
    [inspection.id, f.second.id],
  );
  const after = await inventory(isolated.db, "customers", f.customer.id);
  assert.notEqual(after.fingerprint, before.fingerprint);
});
