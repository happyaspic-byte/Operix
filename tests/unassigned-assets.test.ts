import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { previewImport, commitImport } from "../src/lib/imports.ts";
import {
  getRecord,
  listRecords,
  lookups,
  saveRecord,
} from "../src/lib/records.ts";
import { catalog } from "../src/lib/catalog.ts";
import { AppError } from "../src/lib/policy.ts";
import { parseSheet, workbookBytes } from "../src/lib/sheets.ts";
import type { User } from "../src/lib/auth.ts";

const user: User = {
  id: crypto.randomUUID(),
  email: "unassigned@example.test",
  name: "Synthetic admin",
  role: "admin",
  active: true,
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  process.env.FILE_SCAN_MODE = "test";
  isolated = await isolatedDatabase();
  await isolated.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test-not-a-login-hash')",
    [user.id, user.email, user.name, user.role],
  );
});
after(async () => {
  await isolated?.close();
});

function assetForm(row: Record<string, any>) {
  return Object.fromEntries([
    ...catalog.assets.fields.map((field) => [
      field.key,
      row[field.key] === null &&
      !["relation", "date", "number"].includes(field.type || "")
        ? ""
        : row[field.key],
    ]),
    ["version", row.version],
  ]);
}

const header =
  "display_name,u_system_name,account,serial_number,u_asset_type,location.u_city_state_county_country_combined,u_entitlement,u_service_expiration";
function alm(rows: string[][]) {
  return new File(
    [header + "\n" + rows.map((row) => row.join(",")).join("\n")],
    "synthetic.csv",
  );
}

test("component and VM selectors include unassigned assets but customer-bound selectors never do", async () => {
  const a = await saveRecord("assets", user, {
    name: "Unassigned selector",
    asset_tag: "SELECTOR-NOSITE",
    product: "Server",
  });
  for (const kind of ["components", "vms"]) {
    const choices = await lookups(
      new URLSearchParams({
        current_kind: kind,
        entity: "assets",
        q: "SELECTOR-NOSITE",
      }),
      user,
    );
    assert.deepEqual(
      choices.assets.map((row) => row.id),
      [a.id],
    );
    const fields = kind === "vms" ? { vcpu: 1, memory_gb: 1, disk_gb: 1 } : {};
    const child = await saveRecord(kind, user, {
      name: "Selected child",
      asset_id: a.id,
      ...fields,
    });
    const selected = await lookups(
      new URLSearchParams({
        current_kind: kind,
        current_id: child.id,
        entity: "assets",
        q: "No candidate matches",
      }),
      user,
    );
    assert.deepEqual(
      selected.assets.map((row) => row.id),
      [a.id],
    );
  }
  for (const kind of [
    "",
    "assets",
    "contracts",
    "tickets",
    "inspections",
    "maintenance_plans",
  ]) {
    const choices = await lookups(
      new URLSearchParams({
        current_kind: kind,
        entity: "assets",
        q: "SELECTOR-NOSITE",
      }),
      user,
    );
    assert.equal(choices.assets.length, 0);
  }
  await saveRecord(
    "assets",
    user,
    { ...assetForm(a), status: "archived" },
    a.id,
  );
  for (const kind of ["components", "vms"]) {
    const candidates = await lookups(
      new URLSearchParams({
        current_kind: kind,
        entity: "assets",
        q: "SELECTOR-NOSITE",
      }),
      user,
    );
    assert.equal(candidates.assets.length, 0);
    const [child] = await isolated.db.query(
      `SELECT id FROM ${kind} WHERE asset_id=$1`,
      [a.id],
    );
    const selected = await lookups(
      new URLSearchParams({
        current_kind: kind,
        current_id: child.id,
        entity: "assets",
        q: "No candidate matches",
      }),
      user,
    );
    assert.deepEqual(
      selected.assets.map((row) => [row.id, row.status]),
      [[a.id, "archived"]],
    );
  }
});

test("51 ALM rows in 18 unmatched groups persist visibly without creating organizations", async () => {
  const file = alm(
    Array.from({ length: 51 }, (_, i) => [
      "Unassigned " + i,
      "System " + i,
      "Synthetic customer " + (i % 18),
      "UNASSIGNED-" + i,
      "everRun Enterprise",
      "Synthetic address " + (i % 18),
      "Perpetual Service",
      "2030-01-02",
    ]),
  );
  const preview = await previewImport(user, "assets", file);
  assert.equal(preview.site_groups.length, 18);
  assert.equal(preview.valid, true, JSON.stringify(preview.rows));
  assert.equal(preview.rows.length, 51);
  assert.ok(
    preview.rows.every(
      (row) =>
        row.action === "create" &&
        row.warnings.some((warning: string) =>
          warning.includes("사업장 미지정"),
        ),
    ),
  );
  assert.deepEqual(await commitImport(user, preview.batch_id), {
    count: 51,
    created: 51,
    updated: 0,
  });
  const saved = await isolated.db.query(
    "SELECT * FROM assets WHERE asset_tag LIKE 'UNASSIGNED-%' ORDER BY asset_tag",
  );
  assert.equal(saved.length, 51);
  assert.ok(saved.every((row) => row.site_id === null));
  assert.equal((await isolated.db.query("SELECT * FROM customers")).length, 0);
  assert.equal((await isolated.db.query("SELECT * FROM sites")).length, 0);
  assert.match(saved[0].notes, /ALM 원본 고객사: Synthetic customer 0/);
  assert.match(saved[0].notes, /ALM 원본 위치: Synthetic address 0/);
  assert.match(saved[0].notes, /ALM 시스템명: System 0/);
  assert.equal((await getRecord("assets", saved[0].id, user)).site_id, null);
  const listed = await listRecords(
    "assets",
    user,
    new URLSearchParams({ q: "UNASSIGNED-", limit: "100" }),
  );
  assert.equal(listed.total, 51);
  assert.equal(listed.rows.length, 51);
  const exported = await workbookBytes(listed.rows, [
    ["asset_tag", "자산 ID"],
    ["site_id", "사업장 ID"],
  ]);
  const sheet = await parseSheet(new File([exported], "synthetic-export.xlsx"));
  assert.equal(sheet.length, 51);
  assert.ok(sheet.every((row) => row["사업장 ID"] === ""));
  const repeat = await previewImport(user, "assets", file);
  assert.equal(repeat.valid, true, JSON.stringify(repeat.rows));
  assert.deepEqual(await commitImport(user, repeat.batch_id), {
    count: 51,
    created: 0,
    updated: 51,
  });
  const customer = await saveRecord("customers", user, {
    name: "Later customer",
  });
  const site = await saveRecord("sites", user, {
    name: "Later site",
    customer_id: customer.id,
  });
  const record = await getRecord("assets", saved[0].id, user);
  await saveRecord(
    "assets",
    user,
    { ...assetForm(record), site_id: site.id },
    record.id,
  );
  const reimport = await previewImport(user, "assets", file);
  assert.equal(reimport.valid, true, JSON.stringify(reimport.rows));
  await commitImport(user, reimport.batch_id);
  const assigned = await getRecord("assets", record.id, user);
  assert.equal(assigned.site_id, site.id);
  assert.equal(assigned.notes, saved[0].notes);
  assert.equal(
    (
      await isolated.db.query(
        "SELECT * FROM assets WHERE asset_tag LIKE 'UNASSIGNED-%'",
      )
    ).length,
    51,
  );
  const choices = await lookups(new URLSearchParams(), user);
  assert.ok(!choices.assets.some((row: any) => row.id === saved[1].id));
});

test("unassigned standard imports require stable tags and preserve existing sites on blank input", async () => {
  const file = new File(
    ["자산명,자산 ID,제품\nStandard unassigned,STANDARD-NOSITE,Server"],
    "standard.csv",
  );
  const preview = await previewImport(user, "assets", file);
  assert.equal(preview.valid, true, JSON.stringify(preview.rows));
  await commitImport(user, preview.batch_id);
  const [record] = await isolated.db.query(
    "SELECT * FROM assets WHERE asset_tag='STANDARD-NOSITE'",
  );
  assert.equal(record.site_id, null);
  for (const csv of [
    "자산명,제품\nNo tag,Server",
    "자산명,자산 ID,제품,고객사명\nIncomplete,INCOMPLETE,Server,Unknown",
    "자산명,자산 ID,제품,고객사명,사업장명\nInvalid,INVALID,Server,Unknown,Missing",
    `자산명,자산 ID,제품,사업장 ID\nInvalid ID,INVALID-ID,Server,${crypto.randomUUID()}`,
  ]) {
    assert.equal(
      (await previewImport(user, "assets", new File([csv], "invalid.csv")))
        .valid,
      false,
    );
  }
  const c = await saveRecord("customers", user, { name: "Standard customer" });
  const s = await saveRecord("sites", user, {
    name: "Standard site",
    customer_id: c.id,
  });
  await saveRecord(
    "assets",
    user,
    { ...assetForm(record), site_id: s.id },
    record.id,
  );
  const blank = await previewImport(
    user,
    "assets",
    new File(
      [
        "자산명,자산 ID,제품,사업장 ID\nStandard unassigned,STANDARD-NOSITE,Server,",
      ],
      "blank.csv",
    ),
  );
  assert.equal(blank.valid, true, JSON.stringify(blank.rows));
  await commitImport(user, blank.batch_id);
  assert.equal((await getRecord("assets", record.id, user)).site_id, s.id);
});

test("ALM cannot assign an existing unassigned asset and concurrent editor assignment invalidates its whole batch", async () => {
  const a = await saveRecord("assets", user, {
    name: "Race unassigned",
    asset_tag: "RACE-UNASSIGNED",
    serial: "RACE-UNASSIGNED",
    product: "Server",
  });
  const c = await saveRecord("customers", user, { name: "Race customer" });
  const s = await saveRecord("sites", user, {
    name: "Race site",
    customer_id: c.id,
  });
  const file = alm([
    [
      "Race unassigned",
      "",
      "Race customer",
      "RACE-UNASSIGNED",
      "windows",
      "Race site",
      "",
      "",
    ],
  ]);
  const attempted = await previewImport(user, "assets", file);
  assert.equal(attempted.valid, false);
  assert.match(attempted.rows[0].error, /사업장.*변경/);
  const explicit = await previewImport(
    user,
    "assets",
    file,
    {},
    { [attempted.site_groups[0].key]: s.id },
  );
  assert.equal(explicit.valid, false);
  assert.match(explicit.rows[0].error, /사업장.*변경/);
  const unresolved = alm([
    [
      "Atomic newcomer",
      "",
      "Missing",
      "ATOMIC-NEW",
      "windows",
      "Missing",
      "",
      "",
    ],
    [
      "Race unassigned",
      "",
      "Missing",
      "RACE-UNASSIGNED",
      "windows",
      "Missing",
      "",
      "",
    ],
  ]);
  const pending = await previewImport(user, "assets", unresolved);
  assert.equal(pending.valid, true, JSON.stringify(pending.rows));
  const assigned = await saveRecord(
    "assets",
    user,
    { ...assetForm(a), site_id: s.id },
    a.id,
  );
  await assert.rejects(
    () => commitImport(user, pending.batch_id),
    (e: unknown) => e instanceof AppError && e.status === 409,
  );
  assert.equal(
    (
      await isolated.db.query(
        "SELECT * FROM assets WHERE asset_tag='ATOMIC-NEW'",
      )
    ).length,
    0,
  );
  await assert.rejects(
    () =>
      saveRecord(
        "assets",
        user,
        { ...assetForm(assigned), site_id: null },
        a.id,
      ),
    /사업장.*해제/,
  );
});

test("unassigned assets reject customer-bound work and archived assets reject new components or VMs", async () => {
  const a = await saveRecord("assets", user, {
    name: "Unassigned work",
    asset_tag: "WORK-NOSITE",
    product: "Server",
  });
  const c = await saveRecord("customers", user, { name: "Work customer" });
  await assert.rejects(
    () =>
      saveRecord("maintenance_plans", user, {
        name: "Must assign site",
        asset_id: a.id,
        start_date: "2026-01-01",
        interval_months: "1",
      }),
    (e: unknown) =>
      e instanceof AppError &&
      e.status === 400 &&
      /사업장.*연결/.test(e.message),
  );
  for (const [kind, fields] of [
    [
      "contracts",
      {
        customer_id: c.id,
        asset_ids: [a.id],
        kind: "maintenance",
        term: "unknown",
      },
    ],
    ["tickets", { customer_id: c.id, asset_ids: [a.id] }],
    ["inspections", { asset_ids: [a.id], planned_date: "2026-01-01" }],
  ] as const) {
    await assert.rejects(
      () => saveRecord(kind, user, { name: "Invalid work", ...fields }),
      (e: unknown) => e instanceof AppError && e.status === 400,
    );
  }
  const cpt = await saveRecord("components", user, {
    name: "Before archive",
    asset_id: a.id,
  });
  assert.equal(cpt.asset_id, a.id);
  await saveRecord(
    "assets",
    user,
    { ...assetForm(a), status: "archived" },
    a.id,
  );
  await assert.rejects(
    () =>
      saveRecord("components", user, { name: "After archive", asset_id: a.id }),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
  await assert.rejects(
    () =>
      saveRecord("vms", user, {
        name: "Archived VM",
        asset_id: a.id,
        vcpu: 1,
        memory_gb: 1,
        disk_gb: 1,
      }),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
});

test("explicit ALM site references stay errors and newly archived targets invalidate commits", async () => {
  const c = await saveRecord("customers", user, { name: "Reference customer" });
  const s = await saveRecord("sites", user, {
    name: "Reference site",
    customer_id: c.id,
  });
  const file = alm([
    [
      "Reference asset",
      "",
      "Missing",
      "REFERENCE-ASSET",
      "windows",
      "Missing",
      "",
      "",
    ],
  ]);
  const preview = await previewImport(user, "assets", file);
  const key = preview.site_groups[0].key;
  for (const id of [crypto.randomUUID(), "not-an-id"]) {
    const explicit = new File(
      [
        header +
          ",사업장 ID\nReference asset,,Missing,REFERENCE-ASSET,windows,Missing,,," +
          id,
      ],
      "synthetic.csv",
    );
    assert.equal((await previewImport(user, "assets", explicit)).valid, false);
  }
  assert.equal(
    (
      await previewImport(
        user,
        "assets",
        file,
        {},
        { [key]: crypto.randomUUID() },
      )
    ).valid,
    false,
  );
  const pending = await previewImport(
    user,
    "assets",
    file,
    {},
    { [key]: s.id },
  );
  assert.equal(pending.valid, true, JSON.stringify(pending.rows));
  await saveRecord(
    "sites",
    user,
    { name: s.name, customer_id: c.id, status: "archived", version: s.version },
    s.id,
  );
  assert.equal(
    (await previewImport(user, "assets", file, {}, { [key]: s.id })).valid,
    false,
  );
  await assert.rejects(
    () => commitImport(user, pending.batch_id),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
  assert.equal(
    (
      await isolated.db.query(
        "SELECT * FROM assets WHERE asset_tag='REFERENCE-ASSET'",
      )
    ).length,
    0,
  );
  const activeSite = await saveRecord("sites", user, {
    name: "Customer archived site",
    customer_id: c.id,
  });
  await saveRecord(
    "customers",
    user,
    { name: c.name, status: "archived", version: c.version },
    c.id,
  );
  assert.equal(
    (await previewImport(user, "assets", file, {}, { [key]: activeSite.id }))
      .valid,
    false,
  );
  const a = await saveRecord("assets", user, {
    name: "Assignment guard",
    product: "Server",
  });
  await assert.rejects(
    () =>
      saveRecord(
        "assets",
        user,
        { ...assetForm(a), site_id: activeSite.id },
        a.id,
      ),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
});
