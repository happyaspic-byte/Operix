import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { saveRecord, getRecord } from "../src/lib/records.ts";
import { createReport } from "../src/lib/reports.ts";
import { catalog } from "../src/lib/catalog.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";

const admin: User = {
  id: crypto.randomUUID(),
  name: "Integrity administrator",
  email: "integrity@operix.test",
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
const status = (code: number) => (error: unknown) =>
  error instanceof AppError && error.status === code;
const update = (
  kind: string,
  row: Record<string, any>,
  changes: Record<string, unknown>,
) => ({
  ...Object.fromEntries(
    catalog[kind].fields.map((field) => [field.key, row[field.key]]),
  ),
  version: row.version,
  ...changes,
});
async function fixture() {
  const customer = await saveRecord("customers", admin, {
    name: "Integrity " + crypto.randomUUID(),
  });
  const site = await saveRecord("sites", admin, {
    name: "Integrity site",
    customer_id: customer.id,
  });
  return { customer, site };
}

for (const kind of ["inspections", "tickets"]) {
  test(`erased ${kind} cannot produce a new report or audit entry`, async () => {
    const { customer, site } = await fixture();
    const asset = await saveRecord("assets", admin, {
      name: "Integrity asset",
      site_id: site.id,
      product: "Server",
    });
    const row = await saveRecord(
      kind,
      admin,
      kind === "inspections"
        ? {
            name: "Completed inspection",
            asset_ids: [asset.id],
            planned_date: "2026-09-21",
            status: "completed",
            result: "Synthetic verified result",
          }
        : {
            name: "Resolved ticket",
            customer_id: customer.id,
            asset_ids: [asset.id],
            status: "resolved",
            resolution: "Synthetic resolution",
          },
    );
    await isolated.db.query(
      `UPDATE ${kind} SET privacy_erased_at=now() WHERE id=$1`,
      [row.id],
    );
    await assert.rejects(
      () =>
        createReport(admin, {
          entity_kind: kind,
          entity_id: row.id,
          audience: "customer",
          issue_reason: "Synthetic report issue",
        }),
      status(410),
    );
    const [reports] = await isolated.db.query(
      "SELECT count(*)::int n FROM reports WHERE entity_id=$1",
      [row.id],
    );
    const [audits] = await isolated.db.query(
      "SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1 AND action='approve_report'",
      [row.id],
    );
    assert.equal(reports.n, 0);
    assert.equal(audits.n, 0);
    // Historical reads remain possible; erasure is a write barrier, not a hidden-row filter.
    assert.ok((await getRecord(kind, row.id, admin)).privacy_erased_at);
  });
}

for (const contactStatus of ["active", "archived"]) {
  test(`site with ${contactStatus} contacts cannot move to another customer`, async () => {
    const { customer, site } = await fixture();
    const other = await saveRecord("customers", admin, {
      name: "Other " + crypto.randomUUID(),
    });
    const contact = await saveRecord("customer_contacts", admin, {
      customer_id: customer.id,
      site_id: site.id,
      name: "Synthetic contact",
      status: contactStatus,
    });
    await assert.rejects(
      () =>
        saveRecord(
          "sites",
          admin,
          update("sites", site, { customer_id: other.id }),
          site.id,
        ),
      status(409),
    );
    const current = await getRecord("sites", site.id, admin);
    assert.equal(current.customer_id, customer.id);
    assert.equal(current.version, site.version);
    assert.equal(
      (await getRecord("customer_contacts", contact.id, admin)).customer_id,
      customer.id,
    );
  });
}

test("empty sites remain movable and sites with contacts remain editable within the same customer", async () => {
  const { customer, site } = await fixture();
  const other = await saveRecord("customers", admin, {
    name: "Movable " + crypto.randomUUID(),
  });
  const moved = await saveRecord(
    "sites",
    admin,
    update("sites", site, { customer_id: other.id }),
    site.id,
  );
  assert.equal(moved.customer_id, other.id);
  await saveRecord("customer_contacts", admin, {
    customer_id: other.id,
    site_id: site.id,
    name: "Contact",
  });
  const renamed = await saveRecord(
    "sites",
    admin,
    update("sites", moved, { name: "Renamed site" }),
    site.id,
  );
  assert.equal(renamed.name, "Renamed site");
  assert.notEqual(customer.id, renamed.customer_id);
});
