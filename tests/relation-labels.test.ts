import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { getRecord, listRecords, saveRecord } from "../src/lib/records.ts";
import type { User } from "../src/lib/auth.ts";

const user: User = {
  id: crypto.randomUUID(),
  email: "relation-labels@example.test",
  name: "Synthetic admin",
  role: "admin",
  active: true,
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  isolated = await isolatedDatabase();
  await isolated.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test-not-a-login-hash')",
    [user.id, user.email, user.name, user.role],
  );
});
after(async () => {
  await isolated?.close();
});

test("a successor contract names its predecessor, not its customer", async () => {
  const customer = await saveRecord("customers", user, {
    name: "Label customer",
  });
  const contract = (name: string, predecessorId?: string) =>
    saveRecord("contracts", user, {
      name,
      customer_id: customer.id,
      kind: "maintenance",
      term: "unknown",
      ...(predecessorId ? { predecessor_id: predecessorId } : {}),
    });
  const original = await contract("Original support");
  const renewal = await contract("Renewed support", original.id);

  const successor = await getRecord("contracts", renewal.id, user);
  assert.equal(successor.predecessor_name, "Original support");
  assert.equal(successor.customer_name, "Label customer");
  const first = await getRecord("contracts", original.id, user);
  assert.equal(first.predecessor_name, null);
  assert.equal(first.customer_name, "Label customer");

  // The search matches a contract's own name, never its predecessor's.
  const byOriginal = await listRecords(
    "contracts",
    user,
    new URLSearchParams({ q: "Original" }),
  );
  assert.equal(byOriginal.total, 1);
  assert.deepEqual(
    byOriginal.rows.map((row) => [row.id, row.predecessor_name]),
    [[original.id, null]],
  );
  const byRenewal = await listRecords(
    "contracts",
    user,
    new URLSearchParams({ q: "Renewed" }),
  );
  assert.equal(byRenewal.total, 1);
  assert.deepEqual(
    byRenewal.rows.map((row) => [row.id, row.predecessor_name]),
    [[renewal.id, "Original support"]],
  );
});

test("components and VMs name the asset they belong to, with or without a site", async () => {
  const customer = await saveRecord("customers", user, {
    name: "Asset label customer",
  });
  const site = await saveRecord("sites", user, {
    name: "Asset label site",
    customer_id: customer.id,
  });
  const sited = await saveRecord("assets", user, {
    name: "Sited server",
    asset_tag: "LABEL-SITED",
    product: "Server",
    site_id: site.id,
  });
  const loose = await saveRecord("assets", user, {
    name: "Loose server",
    asset_tag: "LABEL-LOOSE",
    product: "Server",
  });
  const component = await saveRecord("components", user, {
    name: "Node0 module",
    asset_id: sited.id,
  });
  const looseComponent = await saveRecord("components", user, {
    name: "Spare module",
    asset_id: loose.id,
  });
  const vm = await saveRecord("vms", user, {
    name: "App VM",
    asset_id: sited.id,
    vcpu: 2,
    memory_gb: 4,
    disk_gb: 40,
  });

  assert.equal(
    (await getRecord("components", component.id, user)).asset_name,
    "Sited server",
  );
  assert.equal(
    (await getRecord("components", looseComponent.id, user)).asset_name,
    "Loose server",
  );
  assert.equal(
    (await getRecord("vms", vm.id, user)).asset_name,
    "Sited server",
  );

  for (const [name, id, assetName] of [
    ["Node0 module", component.id, "Sited server"],
    ["Spare module", looseComponent.id, "Loose server"],
  ]) {
    const listed = await listRecords(
      "components",
      user,
      new URLSearchParams({ q: name }),
    );
    assert.equal(listed.total, 1);
    assert.deepEqual(
      listed.rows.map((row) => [row.id, row.asset_name]),
      [[id, assetName]],
    );
  }
  const vms = await listRecords(
    "vms",
    user,
    new URLSearchParams({ q: "App VM" }),
  );
  assert.equal(vms.total, 1);
  assert.deepEqual(
    vms.rows.map((row) => [row.id, row.asset_name]),
    [[vm.id, "Sited server"]],
  );
});
