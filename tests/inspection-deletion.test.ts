import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import * as records from "../src/lib/records.ts";
import { details } from "../src/lib/details.ts";
import { overview } from "../src/lib/overview.ts";
import { runJobs } from "../src/lib/jobs.ts";
import { createReport, getReport } from "../src/lib/reports.ts";
import { createFollowUp } from "../src/lib/workflow.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";
import { handoff } from "../src/lib/account.ts";

const admin: User = {
  id: crypto.randomUUID(),
  name: "Trash administrator",
  email: "trash-admin@operix.test",
  role: "admin",
  active: true,
};
const engineer: User = {
  ...admin,
  id: crypto.randomUUID(),
  email: "trash-engineer@operix.test",
  role: "engineer",
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  isolated = await isolatedDatabase();
  for (const u of [admin, engineer])
    await isolated.db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,$4,'unused')",
      [u.id, u.email, u.name, u.role],
    );
});
after(async () => isolated?.close());
const status = (code: number) => (e: unknown) =>
  e instanceof AppError && e.status === code;
async function fixture(state = "cancelled") {
  const c = await records.saveRecord("customers", admin, {
    name: "Trash customer " + crypto.randomUUID(),
  });
  const s = await records.saveRecord("sites", admin, {
    name: "Trash site",
    customer_id: c.id,
  });
  const assets = [];
  for (const name of ["First target", "Second target"])
    assets.push(
      await records.saveRecord("assets", admin, {
        name,
        site_id: s.id,
        asset_tag: crypto.randomUUID(),
      }),
    );
  const input = {
    name: "Inspection trash " + crypto.randomUUID(),
    asset_ids: assets.map((a) => a.id),
    planned_date: "2020-01-01",
    status: state,
    result: state === "completed" ? "Verified result" : "",
    follow_up: "Synthetic follow up",
  };
  const visit = await records.saveRecord("inspections", admin, input);
  return { visit, assets, input };
}
async function markDeleted(id: string) {
  await isolated.db.query(
    "UPDATE inspections SET deleted_at=now(),deleted_by=$2,version=version+1 WHERE id=$1",
    [id, admin.id],
  );
}
const mutate = (u: User, id: string, version: number, deleted: boolean) =>
  records.setInspectionDeleted(u, id, { version }, deleted);

test("ordinary inspection lists omit trash while authorized trash filters return it", async () => {
  const f = await fixture();
  await markDeleted(f.visit.id);
  const q = new URLSearchParams({ q: f.visit.name });
  assert.equal((await records.listRecords("inspections", admin, q)).total, 0);
  q.set("trash", "1");
  q.set("status", "cancelled");
  const result = await records.listRecords("inspections", admin, q);
  assert.deepEqual(
    result.rows.map((r) => r.id),
    [f.visit.id],
  );
  assert.equal(result.rows[0].asset_ids.length, 2);
  await assert.rejects(
    () => records.listRecords("inspections", engineer, q),
    status(403),
  );
});
test("deleted inspections reject ordinary reads and edits but retain read-only administrator details", async () => {
  const f = await fixture();
  await markDeleted(f.visit.id);
  await assert.rejects(
    () => records.getRecord("inspections", f.visit.id, admin),
    status(410),
  );
  const d = await details("inspections", f.visit.id, admin);
  assert.ok(d.record.deleted_at);
  assert.equal(d.record.asset_ids.length, 2);
  await assert.rejects(
    () => details("inspections", f.visit.id, engineer),
    status(403),
  );
  await assert.rejects(
    () =>
      records.saveRecord(
        "inspections",
        admin,
        { ...f.input, name: "Overwritten", version: 2 },
        f.visit.id,
      ),
    status(410),
  );
  const [stored] = await isolated.db.query(
    "SELECT name FROM inspections WHERE id=$1",
    [f.visit.id],
  );
  assert.equal(stored.name, f.input.name);
});
test("trash disappears from every target asset, dashboard and scheduler notifications", async () => {
  const f = await fixture("scheduled");
  await markDeleted(f.visit.id);
  for (const a of f.assets)
    assert.equal((await details("assets", a.id, admin)).totals.inspections, 0);
  const before = await overview(admin);
  assert.ok(!before.inspections.some((r) => r.id === f.visit.id));
  await runJobs("2020-01-01");
  assert.equal(
    (
      await isolated.db.query(
        "SELECT id FROM notifications WHERE source_kind='inspections' AND source_id=$1",
        [f.visit.id],
      )
    ).length,
    0,
  );
});
test("trash blocks new reports and follow-up work while preserving issued report snapshots", async () => {
  const f = await fixture("completed");
  const report = await createReport(admin, {
    entity_kind: "inspections",
    entity_id: f.visit.id,
    audience: "customer",
    issue_reason: "Synthetic report preservation",
  });
  const frozen = (await getReport(admin, report.id)).snapshot;
  await markDeleted(f.visit.id);
  await assert.rejects(
    () =>
      createReport(admin, {
        entity_kind: "inspections",
        entity_id: f.visit.id,
        issue_reason: "Must not create after deletion",
      }),
    status(410),
  );
  await assert.rejects(
    () => createFollowUp(admin, f.visit.id, "Must not create after deletion"),
    status(410),
  );
  assert.deepEqual((await getReport(admin, report.id)).snapshot, frozen);
});
test("deletion and restoration preserve targets, status and audit history, with version conflict protection", async () => {
  const f = await fixture();
  let deleted: any;
  await assert.doesNotReject(async () => {
    deleted = await mutate(admin, f.visit.id, 1, true);
  });
  assert.ok(deleted.deleted_at);
  assert.equal(deleted.deleted_by, admin.id);
  assert.equal(deleted.version, 2);
  assert.equal(deleted.status, "cancelled");
  assert.deepEqual(new Set(deleted.asset_ids), new Set(f.input.asset_ids));
  await assert.rejects(() => mutate(admin, f.visit.id, 1, false), status(409));
  const restored = await mutate(admin, f.visit.id, 2, false);
  assert.equal(restored.deleted_at, null);
  assert.equal(restored.version, 3);
  assert.equal(restored.status, "cancelled");
  assert.equal(
    (
      await records.listRecords(
        "inspections",
        admin,
        new URLSearchParams({ q: f.visit.name }),
      )
    ).total,
    1,
  );
  const audit = await isolated.db.query(
    "SELECT action FROM audit_logs WHERE entity_kind='inspections' AND entity_id=$1 ORDER BY created_at,id",
    [f.visit.id],
  );
  assert.ok(audit.some((r) => r.action === "delete"));
  assert.ok(audit.some((r) => r.action === "restore"));
});
test("non-managers, revoked administrators and erased records cannot change trash state", async () => {
  const f = await fixture();
  await assert.rejects(
    () => mutate(engineer, f.visit.id, 1, true),
    status(403),
  );
  await isolated.db.query("UPDATE users SET active=false WHERE id=$1", [
    admin.id,
  ]);
  try {
    await assert.rejects(() => mutate(admin, f.visit.id, 1, true), status(403));
  } finally {
    await isolated.db.query("UPDATE users SET active=true WHERE id=$1", [
      admin.id,
    ]);
  }
  await isolated.db.query(
    "UPDATE inspections SET privacy_erased_at=now() WHERE id=$1",
    [f.visit.id],
  );
  await assert.rejects(() => mutate(admin, f.visit.id, 1, true), status(410));
});
test("deletion removes existing reminders and the scheduler never recreates a deleted planned occurrence", async () => {
  const f = await fixture("scheduled");
  const plan = await records.saveRecord("maintenance_plans", admin, {
    name: "Repeated trash visit",
    asset_id: f.assets[0].id,
    start_date: "2020-01-01",
    interval_months: "12",
  });
  await runJobs("2020-01-01");
  const [occurrence] = await isolated.db.query(
    "SELECT * FROM inspections WHERE plan_id=$1",
    [plan.id],
  );
  assert.ok(
    (
      await isolated.db.query(
        "SELECT id FROM notifications WHERE source_id=$1",
        [occurrence.id],
      )
    ).length > 0,
  );
  await mutate(admin, occurrence.id, occurrence.version, true);
  await isolated.db.query(
    "UPDATE maintenance_plans SET next_index=0 WHERE id=$1",
    [plan.id],
  );
  await runJobs("2020-01-01");
  const rows = await isolated.db.query(
    "SELECT id,deleted_at FROM inspections WHERE plan_id=$1",
    [plan.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, occurrence.id);
  assert.ok(rows[0].deleted_at);
  assert.equal(
    (
      await isolated.db.query(
        "SELECT id FROM notifications WHERE source_id=$1",
        [occurrence.id],
      )
    ).length,
    0,
  );
});
test("handoff leaves deleted inspection assignments unchanged", async () => {
  const f = await fixture("scheduled");
  await isolated.db.query("UPDATE inspections SET assignee_id=$2 WHERE id=$1", [
    f.visit.id,
    engineer.id,
  ]);
  await markDeleted(f.visit.id);
  const result = await handoff(admin, engineer.id, admin.id);
  assert.equal(result.inspections, 0);
  const [record] = await isolated.db.query(
    "SELECT assignee_id FROM inspections WHERE id=$1",
    [f.visit.id],
  );
  assert.equal(record.assignee_id, engineer.id);
});
