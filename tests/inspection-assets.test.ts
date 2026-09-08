import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { User } from "../src/lib/auth.ts";
import type { Database, Row } from "../src/lib/db.ts";
import {
  getRecord,
  listRecords,
  lookups,
  saveRecord,
} from "../src/lib/records.ts";
import { AppError } from "../src/lib/policy.ts";
import { runJobs } from "../src/lib/jobs.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let db: Database;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
const user: User = {
  id: crypto.randomUUID(),
  email: "inspection-assets@example.test",
  name: "Inspection assets administrator",
  role: "admin",
  active: true,
};

before(async () => {
  fixture = await isolatedDatabase();
  db = fixture.db;
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'unused-test-password')",
    [user.id, user.email, user.name, user.role],
  );
});

after(async () => {
  await fixture?.close();
});

async function fresh() {
  const customer = await saveRecord("customers", user, {
    name: "Inspection customer " + crypto.randomUUID(),
  });
  const site = await saveRecord("sites", user, {
    customer_id: customer.id,
    name: "Inspection site",
  });
  const asset = await saveRecord("assets", user, {
    site_id: site.id,
    name: "Primary inspection asset",
    product: "Server",
  });
  return { customer, site, asset };
}

function addAsset(siteId: string, name = "Additional inspection asset") {
  return saveRecord("assets", user, {
    site_id: siteId,
    name,
    asset_tag: "INS-" + crypto.randomUUID(),
    product: "Server",
  });
}

function visit(assetIds: string[], extra: Row = {}) {
  return saveRecord("inspections", user, {
    name: "Multiple asset visit " + crypto.randomUUID(),
    planned_date: "2026-10-01",
    asset_ids: assetIds,
    ...extra,
  });
}

function editVisit(row: Row, changes: Row, legacy = false) {
  return saveRecord(
    "inspections",
    user,
    {
      name: row.name,
      planned_date: row.planned_date,
      status: row.status,
      checklist: row.checklist,
      result: row.result,
      follow_up: row.follow_up,
      version: row.version,
      ...(legacy ? { asset_id: row.asset_id } : { asset_ids: row.asset_ids }),
      ...changes,
    },
    row.id,
  );
}

function editAsset(row: Row, changes: Row) {
  return saveRecord(
    "assets",
    user,
    {
      site_id: row.site_id,
      name: row.name,
      product: row.product,
      asset_tag: row.asset_tag || "",
      version: row.version,
      ...changes,
    },
    row.id,
  );
}

const status = (expected: number) => (error: unknown) =>
  error instanceof AppError && error.status === expected;

async function linkedAssets(inspectionId: string) {
  return (
    await db.query(
      "SELECT asset_id FROM inspection_assets WHERE inspection_id=$1 ORDER BY asset_id",
      [inspectionId],
    )
  ).map((row) => row.asset_id);
}

test("Legacy inspection creation returns its target through asset_ids", async () => {
  const { asset } = await fresh();
  const created = await saveRecord("inspections", user, {
    asset_id: asset.id,
    name: "Legacy single asset visit",
    planned_date: "2026-10-01",
  });
  const inspection = await getRecord("inspections", created.id, user);
  assert.deepEqual(inspection.asset_ids, [asset.id]);
});

test("Multiple selected assets remain one visit with complete display and customer data", async () => {
  const { customer, site, asset } = await fresh();
  const extra = await addAsset(site.id);
  const row = await visit([asset.id, extra.id]);
  const actual = await getRecord("inspections", row.id, user);
  assert.deepEqual(actual.asset_ids, [asset.id, extra.id]);
  assert.equal(actual.asset_id, asset.id);
  assert.equal(actual.customer_id, customer.id);
  assert.deepEqual(actual.assets, [
    { id: asset.id, name: asset.name, asset_tag: null },
    { id: extra.id, name: extra.name, asset_tag: extra.asset_tag },
  ]);
  assert.ok(actual.asset_name.includes(asset.name));
  assert.ok(actual.asset_name.includes(extra.name));
  const list = await listRecords(
    "inspections",
    user,
    new URLSearchParams({ q: row.name }),
  );
  assert.equal(list.total, 1);
  assert.deepEqual(
    list.rows.map((item) => item.id),
    [row.id],
  );
  assert.deepEqual(await linkedAssets(row.id), [asset.id, extra.id].sort());
});

test("A visit accepts several sites belonging to the same customer", async () => {
  const { customer, asset } = await fresh();
  const otherSite = await saveRecord("sites", user, {
    customer_id: customer.id,
    name: "Another installation site",
  });
  const extra = await addAsset(otherSite.id);
  const row = await visit([asset.id, extra.id]);
  assert.deepEqual(row.asset_ids, [asset.id, extra.id]);
  assert.equal(row.customer_id, customer.id);
});

test("Repeated selections are deduplicated without creating another visit", async () => {
  const { asset, site } = await fresh();
  const extra = await addAsset(site.id);
  const row = await visit([asset.id, asset.id, extra.id, extra.id]);
  assert.deepEqual(row.asset_ids, [asset.id, extra.id]);
  assert.deepEqual(await linkedAssets(row.id), [asset.id, extra.id].sort());
});

for (const [label, ids] of [
  ["empty", []],
  ["malformed UUID", ["invalid-asset-id"]],
  ["missing asset", [crypto.randomUUID()]],
  [
    "more than 200 assets",
    Array.from({ length: 201 }, () => crypto.randomUUID()),
  ],
] as const) {
  test(`Invalid ${label} selection is rejected without creating a visit`, async () => {
    const name = "Rejected visit " + crypto.randomUUID();
    await assert.rejects(() => visit([...ids], { name }), status(400));
    const rows = await db.query("SELECT id FROM inspections WHERE name=$1", [
      name,
    ]);
    assert.deepEqual(rows, []);
  });
}

test("A visit cannot mix assets from different customers", async () => {
  const first = await fresh();
  const second = await fresh();
  await assert.rejects(
    () => visit([first.asset.id, second.asset.id]),
    status(400),
  );
});

test("The 200 asset boundary is accepted as a single visit", async () => {
  const { site, asset } = await fresh();
  const ids = [asset.id];
  for (let index = 1; index < 200; index++) {
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO assets(id,site_id,name,product) VALUES ($1,$2,$3,'Server')",
      [id, site.id, "Boundary asset " + index],
    );
    ids.push(id);
  }
  const row = await visit(ids);
  assert.equal(row.asset_ids.length, 200);
  assert.equal(row.asset_id, asset.id);
  assert.equal((await linkedAssets(row.id)).length, 200);
  assert.equal(
    (
      await listRecords(
        "inspections",
        user,
        new URLSearchParams({ q: row.name }),
      )
    ).total,
    1,
  );
  const overflow = await addAsset(site.id, "Asset beyond the selection limit");
  await assert.rejects(() => visit([...ids, overflow.id]), status(400));
});

test("Changing selections replaces links and advances the version once", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id, "Second asset");
  const third = await addAsset(site.id, "Third asset");
  const row = await visit([asset.id, second.id]);
  const updated = await editVisit(row, { asset_ids: [third.id, second.id] });
  assert.equal(updated.id, row.id);
  assert.equal(updated.version, row.version + 1);
  assert.equal(updated.asset_id, third.id);
  assert.deepEqual(updated.asset_ids, [third.id, second.id]);
  assert.deepEqual(await linkedAssets(row.id), [third.id, second.id].sort());
});

test("A stale version cannot overwrite the visit or its asset selections", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id);
  const row = await visit([asset.id]);
  const updated = await editVisit(row, {
    asset_ids: [asset.id, second.id],
    result: "Latest note",
  });
  await assert.rejects(
    () => editVisit(row, { asset_ids: [second.id], result: "Stale note" }),
    status(409),
  );
  const actual = await getRecord("inspections", row.id, user);
  assert.equal(actual.result, "Latest note");
  assert.equal(actual.version, updated.version);
  assert.deepEqual(actual.asset_ids, [asset.id, second.id]);
});

test("Invalid replacement rolls back the name, version and existing links", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id);
  const row = await visit([asset.id, second.id]);
  await assert.rejects(
    () =>
      editVisit(row, {
        name: "Must not persist",
        asset_ids: [asset.id, crypto.randomUUID()],
      }),
    status(400),
  );
  const actual = await getRecord("inspections", row.id, user);
  assert.equal(actual.name, row.name);
  assert.equal(actual.version, row.version);
  assert.deepEqual(await linkedAssets(row.id), [asset.id, second.id].sort());
});

test("A failed relation insert rolls back the visit update and deleted links", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id);
  const rejected = await addAsset(site.id, "Rejected new relation");
  const row = await visit([asset.id, second.id]);
  await db.exec(`
    CREATE FUNCTION reject_inspection_test_link() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic relation insert rejected'; END;
    $$;
    CREATE TRIGGER reject_inspection_test_link BEFORE INSERT ON inspection_assets
    FOR EACH ROW WHEN (NEW.asset_id='${rejected.id}')
    EXECUTE FUNCTION reject_inspection_test_link();
  `);
  try {
    await assert.rejects(
      () =>
        editVisit(row, {
          name: "Must roll back",
          asset_ids: [asset.id, rejected.id],
        }),
      /synthetic relation insert rejected/,
    );
    const actual = await getRecord("inspections", row.id, user);
    assert.equal(actual.name, row.name);
    assert.equal(actual.version, row.version);
    assert.deepEqual(await linkedAssets(row.id), [asset.id, second.id].sort());
  } finally {
    await db.exec(
      "DROP TRIGGER reject_inspection_test_link ON inspection_assets; DROP FUNCTION reject_inspection_test_link();",
    );
  }
});

test("A legacy update retains additional assets when the representative stays unchanged", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id);
  const row = await visit([asset.id, second.id]);
  const updated = await editVisit(row, { result: "Legacy editor note" }, true);
  assert.deepEqual(updated.asset_ids, [asset.id, second.id]);
  assert.equal(updated.result, "Legacy editor note");
});

test("Replacing the legacy representative preserves additional assets and removes the old representative", async () => {
  const { site, asset } = await fresh();
  const second = await addAsset(site.id, "Retained additional asset");
  const third = await addAsset(site.id, "Replacement representative");
  const row = await visit([asset.id, second.id]);
  const updated = await editVisit(row, { asset_id: third.id }, true);
  assert.equal(updated.asset_id, third.id);
  assert.deepEqual(updated.asset_ids, [third.id, second.id]);
  assert.deepEqual(await linkedAssets(row.id), [third.id, second.id].sort());
});

test("Replacing every asset cannot move an existing visit to another customer", async () => {
  const first = await fresh();
  const other = await fresh();
  const row = await visit([first.asset.id]);
  await assert.rejects(
    () => editVisit(row, { asset_ids: [other.asset.id] }),
    status(409),
  );
  await assert.rejects(
    () => editVisit(row, { asset_id: other.asset.id }, true),
    status(409),
  );
  assert.deepEqual((await getRecord("inspections", row.id, user)).asset_ids, [
    first.asset.id,
  ]);
});

for (const archivedKind of ["assets", "sites", "customers"] as const) {
  test(`A new connection to an asset under archived ${archivedKind} is rejected`, async () => {
    const { customer, site, asset } = await fresh();
    const target =
      archivedKind === "assets"
        ? asset
        : archivedKind === "sites"
          ? site
          : customer;
    const input =
      archivedKind === "assets"
        ? { site_id: site.id, product: asset.product }
        : archivedKind === "sites"
          ? { customer_id: customer.id }
          : {};
    await saveRecord(
      archivedKind,
      user,
      {
        ...input,
        name: target.name,
        version: target.version,
        status: "archived",
      },
      target.id,
    );
    await assert.rejects(() => visit([asset.id]), status(400));
  });

  test(`Archiving secondary ${archivedKind} cancels scheduled visits and preserves active/completed history and links`, async () => {
    const { customer, asset } = await fresh();
    const secondarySite = await saveRecord("sites", user, {
      customer_id: customer.id,
      name: "Secondary installation site",
    });
    const secondary = await addAsset(secondarySite.id);
    const ids = [asset.id, secondary.id];
    const scheduled = await visit(ids);
    const active = await visit(ids, { status: "in_progress" });
    const completed = await visit(ids, {
      status: "completed",
      result: "Both assets checked",
    });
    if (archivedKind === "assets")
      await editAsset(secondary, { status: "archived" });
    else if (archivedKind === "sites")
      await saveRecord(
        "sites",
        user,
        {
          name: secondarySite.name,
          customer_id: customer.id,
          status: "archived",
          version: secondarySite.version,
        },
        secondarySite.id,
      );
    else
      await saveRecord(
        "customers",
        user,
        { name: customer.name, status: "archived", version: customer.version },
        customer.id,
      );
    for (const [row, expected] of [
      [scheduled, "cancelled"],
      [active, "in_progress"],
      [completed, "completed"],
    ] as const) {
      const actual = await getRecord("inspections", row.id, user);
      assert.equal(actual.status, expected);
      assert.deepEqual(actual.asset_ids, ids);
      assert.deepEqual(await linkedAssets(row.id), [...ids].sort());
    }
    const existing = await getRecord("inspections", completed.id, user);
    const revised = await editVisit(existing, {
      result: "Historical result clarified",
    });
    assert.deepEqual(revised.asset_ids, ids);
    assert.equal(revised.status, "completed");
  });
}

for (const position of ["representative", "additional"] as const) {
  test(`The ${position} inspection asset cannot move to another customer`, async () => {
    const { site, asset } = await fresh();
    const extra = await addAsset(site.id);
    const other = await fresh();
    await visit([asset.id, extra.id]);
    const target = position === "representative" ? asset : extra;
    await assert.rejects(
      () => editAsset(target, { site_id: other.site.id }),
      status(409),
    );
    assert.equal((await getRecord("assets", target.id, user)).site_id, site.id);
  });
}

test("Concurrent inspection linking and asset customer migration cannot create a cross-customer visit", async () => {
  const { site, asset } = await fresh();
  const extra = await addAsset(site.id);
  const other = await fresh();
  const name = "Concurrent asset visit " + crypto.randomUUID();
  const [linking, moving] = await Promise.allSettled([
    visit([asset.id, extra.id], { name }),
    editAsset(extra, { site_id: other.site.id }),
  ]);
  assert.equal(
    [linking, moving].filter((result) => result.status === "fulfilled").length,
    1,
  );
  const actualAsset = await getRecord("assets", extra.id, user);
  if (linking.status === "fulfilled") {
    assert.equal(moving.status, "rejected");
    if (moving.status === "rejected") assert.ok(status(409)(moving.reason));
    assert.equal(actualAsset.site_id, site.id);
    assert.deepEqual(
      await linkedAssets(linking.value.id),
      [asset.id, extra.id].sort(),
    );
  } else {
    assert.ok(status(400)(linking.reason));
    assert.equal(actualAsset.site_id, other.site.id);
    assert.deepEqual(
      await db.query("SELECT id FROM inspections WHERE name=$1", [name]),
      [],
    );
  }
});

test("Customer asset lookup filters before its limit and includes customer/site names", async () => {
  const { customer, site, asset } = await fresh();
  const unrelated = await fresh();
  const prefix = "Lookup target " + crypto.randomUUID();
  await editAsset(asset, { name: prefix + " z selected" });
  for (let index = 0; index < 105; index++)
    await db.query(
      "INSERT INTO assets(id,site_id,name,product) VALUES ($1,$2,$3,'Server')",
      [
        crypto.randomUUID(),
        unrelated.site.id,
        prefix + " a unrelated " + index,
      ],
    );
  const result = await lookups(
    new URLSearchParams({
      entity: "assets",
      customer_id: customer.id,
      q: prefix,
    }),
    user,
  );
  assert.deepEqual(
    result.assets.map((row) => row.id),
    [asset.id],
  );
  assert.equal(result.assets[0].customer_id, customer.id);
  assert.equal(result.assets[0].customer_name, customer.name);
  assert.equal(result.assets[0].site_name, site.name);
});

test("Current inspection lookup retains an archived additional asset", async () => {
  const { customer, site, asset } = await fresh();
  const extra = await addAsset(site.id);
  const row = await visit([asset.id, extra.id]);
  await editAsset(extra, { status: "archived" });
  const result = await lookups(
    new URLSearchParams({
      entity: "assets",
      customer_id: customer.id,
      current_kind: "inspections",
      current_id: row.id,
    }),
    user,
  );
  assert.ok(
    result.assets.some(
      (candidate) =>
        candidate.id === extra.id && candidate.status === "archived",
    ),
  );
});

test("Raw legacy inserts remain readable with their representative as a fallback", async () => {
  const { customer, asset } = await fresh();
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO inspections(id,asset_id,name,planned_date) VALUES ($1,$2,'Raw legacy visit','2026-10-01')",
    [id, asset.id],
  );
  assert.deepEqual(await linkedAssets(id), []);
  const row = await getRecord("inspections", id, user);
  assert.deepEqual(row.asset_ids, [asset.id]);
  assert.equal(row.asset_id, asset.id);
  assert.equal(row.customer_id, customer.id);
});

test("Scheduler creates one occurrence with its original asset link and stays idempotent", async () => {
  const { asset } = await fresh();
  const plan = await saveRecord("maintenance_plans", user, {
    name: "Single target plan",
    asset_id: asset.id,
    start_date: "2026-10-01",
    interval_months: "12",
  });
  await runJobs("2026-10-01");
  await runJobs("2026-10-01");
  const rows = await db.query(
    "SELECT id,asset_id,planned_date FROM inspections WHERE plan_id=$1 ORDER BY planned_date",
    [plan.id],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].planned_date, "2026-10-01");
  assert.equal(rows[0].asset_id, asset.id);
  assert.deepEqual(await linkedAssets(rows[0].id), [asset.id]);
});

test("Generated visits allow extra assets but preserve their plan representative", async () => {
  const { asset, site } = await fresh();
  const extra = await addAsset(site.id);
  const plan = await saveRecord("maintenance_plans", user, {
    name: "Stable representative plan",
    asset_id: asset.id,
    start_date: "2026-10-01",
    interval_months: "12",
  });
  await runJobs("2026-10-01");
  const [generated] = await db.query(
    "SELECT id FROM inspections WHERE plan_id=$1",
    [plan.id],
  );
  const row = await getRecord("inspections", generated.id, user);
  const expanded = await editVisit(row, { asset_ids: [asset.id, extra.id] });
  assert.deepEqual(expanded.asset_ids, [asset.id, extra.id]);
  await assert.rejects(
    () => editVisit(expanded, { asset_ids: [extra.id] }),
    status(409),
  );
  await assert.rejects(
    () => editVisit(expanded, { asset_ids: [extra.id, asset.id] }),
    status(409),
  );
  await assert.rejects(
    () => editVisit(expanded, { asset_id: extra.id }, true),
    status(409),
  );
  const [unchangedPlan] = await db.query(
    "SELECT asset_id FROM maintenance_plans WHERE id=$1",
    [plan.id],
  );
  assert.equal(unchangedPlan.asset_id, asset.id);
  assert.deepEqual(
    (await getRecord("inspections", generated.id, user)).asset_ids,
    [asset.id, extra.id],
  );
});

test("Migration backfills historical representatives without changing visit identity or completion", async () => {
  const { asset } = await fresh();
  const id = crypto.randomUUID();
  await db.exec("DROP TABLE inspection_assets");
  await db.query(
    "INSERT INTO inspections(id,asset_id,name,planned_date,status,result,version) VALUES ($1,$2,'Historical completed visit','2026-09-01','completed','Preserved result',7)",
    [id, asset.id],
  );
  await db.exec(await readFile("db/004_inspection_assets.sql", "utf8"));
  const row = await getRecord("inspections", id, user);
  assert.equal(row.id, id);
  assert.equal(row.asset_id, asset.id);
  assert.equal(row.status, "completed");
  assert.equal(row.result, "Preserved result");
  assert.equal(row.version, 7);
  assert.deepEqual(row.asset_ids, [asset.id]);
  assert.deepEqual(await linkedAssets(id), [asset.id]);
});
