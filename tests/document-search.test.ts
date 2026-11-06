import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/lib/auth.ts";
import type { Database } from "../src/lib/db.ts";
import { listDocuments } from "../src/lib/documents.ts";
import { listReports } from "../src/lib/reports.ts";
import { saveRecord } from "../src/lib/records.ts";
import { AppError } from "../src/lib/policy.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let fixture: { db: Database; close: () => Promise<void> };
let db: Database;
const admin: User = {
  id: crypto.randomUUID(),
  email: "search-admin@example.test",
  name: "Search admin",
  role: "admin",
  active: true,
};
const viewer: User = {
  ...admin,
  id: crypto.randomUUID(),
  email: "search-viewer@example.test",
  role: "viewer",
};
let customer: string;
let otherCustomer: string;
let inspection: string;
let otherInspection: string;
const docs = Array.from({ length: 5 }, () => crypto.randomUUID());
const reports = Array.from({ length: 4 }, () => crypto.randomUUID());

before(async () => {
  fixture = await isolatedDatabase();
  db = fixture.db;
  for (const user of [admin, viewer])
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'unused')",
      [user.id, user.email, user.name, user.role],
    );
  async function makeInspection(name: string) {
    const c = await saveRecord("customers", admin, { name });
    const s = await saveRecord("sites", admin, {
      name: name + " site",
      customer_id: c.id,
    });
    const a = await saveRecord("assets", admin, {
      name: name + " asset",
      site_id: s.id,
      product: "Server",
    });
    const i = await saveRecord("inspections", admin, {
      name: name + " inspection",
      asset_ids: [a.id],
      planned_date: "2026-01-01",
    });
    return { customer: c.id, inspection: i.id };
  }
  const a = await makeInspection("Search one");
  const b = await makeInspection("Search two");
  customer = a.customer;
  inspection = a.inspection;
  otherCustomer = b.customer;
  otherInspection = b.inspection;
  const documentFixtures = [
    [
      docs[0],
      inspection,
      "needle-start.txt",
      "internal",
      "clean",
      admin.id,
      "2026-01-01T15:00:00Z",
    ],
    [
      docs[1],
      inspection,
      "needle-end.txt",
      "restricted",
      "pending",
      viewer.id,
      "2026-01-02T14:59:59Z",
    ],
    [
      docs[2],
      inspection,
      "needle-before.txt",
      "internal",
      "error",
      admin.id,
      "2026-01-01T14:59:59Z",
    ],
    [
      docs[3],
      otherInspection,
      "needle-other.txt",
      "internal",
      "clean",
      admin.id,
      "2026-01-02T15:00:00Z",
    ],
    [
      docs[4],
      inspection,
      "needle-deleted.txt",
      "internal",
      "clean",
      admin.id,
      "2026-01-02T00:00:00Z",
    ],
  ];
  for (const [
    id,
    entity,
    name,
    classification,
    scan,
    uploader,
    created,
  ] of documentFixtures)
    await db.query(
      "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by,classification,scan_status,created_at,deleted_at) VALUES ($1,'inspections',$2,$3,'text/plain',1,$1,$4,$5,$6,$7,CASE WHEN $1=$8 THEN now() ELSE NULL END)",
      [id, entity, name, uploader, classification, scan, created, docs[4]],
    );
  for (const [index, id] of reports.entries())
    await db.query(
      "INSERT INTO reports(id,entity_kind,entity_id,revision,title,snapshot,approved_by,classification,created_at,document_number,withdrawn_at) VALUES ($1,'inspections',$2,$3,$4,'{}',$5,$6,$7,$8,CASE WHEN $3=4 THEN now() ELSE NULL END)",
      [
        id,
        index === 2 ? otherInspection : inspection,
        index + 1,
        `needle-report-${index}`,
        index === 1 ? viewer.id : admin.id,
        index === 1 ? "restricted" : "internal",
        index === 0 ? "2026-01-01T15:00:00Z" : "2026-01-02T14:59:59Z",
        `SEARCH-${index}`,
      ],
    );
});

after(async () => {
  await fixture?.close();
});

const query = (params: Record<string, string> = {}) =>
  new URLSearchParams(params);
const ids = (rows: Record<string, any>[]) => rows.map((row) => row.id).sort();

test("document filters combine and totals are scoped before pagination", async () => {
  const all = await listDocuments(admin, query());
  assert.equal(all.total, 4);
  const filtered = await listDocuments(
    admin,
    query({
      customer_id: customer,
      entity_kind: "inspections",
      classification: "internal",
      scan_status: "clean",
      from: "2026-01-02",
      to: "2026-01-02",
      uploader_id: admin.id,
      q: "NEEDLE",
      limit: "1",
    }),
  );
  assert.equal(filtered.total, 1);
  assert.deepEqual(ids(filtered.rows), [docs[0]]);
  assert.deepEqual(
    ids(
      (await listDocuments(admin, query({ customer_id: otherCustomer }))).rows,
    ),
    [docs[3]],
  );
  assert.deepEqual(
    ids(
      (
        await listDocuments(
          admin,
          query({ scan_status: "pending", uploader_id: viewer.id }),
        )
      ).rows,
    ),
    [docs[1]],
  );
  assert.equal(
    (await listDocuments(admin, query({ entity_kind: "tickets" }))).total,
    0,
  );
  const page = await listDocuments(
    admin,
    query({ q: "needle", limit: "1", page: "2" }),
  );
  assert.equal(page.total, 4);
  assert.equal(page.rows.length, 1);
  const visible = await listDocuments(
    viewer,
    query({ q: "needle", limit: "1" }),
  );
  assert.equal(visible.total, 3);
  assert.equal(visible.rows.length, 1);
  assert.equal(
    (await listDocuments(viewer, query({ classification: "restricted" })))
      .total,
    0,
  );
});

test("report filters and totals respect classification permissions", async () => {
  assert.equal((await listReports(admin, query())).total, 3);
  const result = await listReports(
    admin,
    query({
      customer_id: customer,
      entity_kind: "inspections",
      classification: "internal",
      from: "2026-01-02",
      to: "2026-01-02",
      uploader_id: admin.id,
      q: "needle-report-0",
    }),
  );
  assert.equal(result.total, 1);
  assert.deepEqual(ids(result.rows), [reports[0]]);
  assert.deepEqual(
    ids((await listReports(admin, query({ customer_id: otherCustomer }))).rows),
    [reports[2]],
  );
  const visible = await listReports(viewer, query({ q: "needle", limit: "1" }));
  assert.equal(visible.total, 2);
  assert.equal(visible.rows.length, 1);
  assert.equal(
    (await listReports(viewer, query({ classification: "restricted" }))).total,
    0,
  );
  assert.equal(
    (await listReports(admin, query({ scan_status: "clean" }))).total,
    3,
  );
});

test("KST calendar dates include both boundaries but exclude adjacent instants", async () => {
  const result = await listDocuments(
    admin,
    query({ from: "2026-01-02", to: "2026-01-02" }),
  );
  assert.deepEqual(ids(result.rows), [docs[0], docs[1]].sort());
  const report = await listReports(
    admin,
    query({ customer_id: customer, from: "2026-01-02", to: "2026-01-02" }),
  );
  assert.deepEqual(ids(report.rows), [reports[0], reports[1]].sort());
});

test("invalid filters fail validation instead of returning an unfiltered listing", async () => {
  const invalid: Record<string, string>[] = [
    { customer_id: "not-a-uuid" },
    { uploader_id: "not-a-uuid" },
    { entity_kind: "unknown" },
    { classification: "unknown" },
    { from: "2026-02-30" },
    { to: "0000-01-01" },
    { from: "2026-02-02", to: "2026-02-01" },
    { scan_status: "unknown" },
  ];
  for (const params of invalid) {
    for (const list of [listDocuments, listReports])
      await assert.rejects(
        () => list(admin, query(params)),
        (error: unknown) => error instanceof AppError && error.status === 400,
        JSON.stringify(params),
      );
  }
});

test("sales totals and rows exclude network and restricted documents and reports", async () => {
  const sales: User = {
    ...admin,
    id: crypto.randomUUID(),
    email: "search-sales@example.test",
    role: "sales",
  };
  const documentIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  const reportIds = Array.from({ length: 4 }, () => crypto.randomUUID());
  const classes = ["internal", "financial", "network", "restricted"];
  for (const [index, classification] of classes.entries()) {
    await db.query(
      "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by,classification,scan_status) VALUES ($1,'inspections',$2,$3,'text/plain',1,$1,$4,$5,'clean')",
      [
        documentIds[index],
        inspection,
        `sales-scope-document-${index}`,
        admin.id,
        classification,
      ],
    );
    await db.query(
      "INSERT INTO reports(id,entity_kind,entity_id,revision,title,snapshot,approved_by,classification) VALUES ($1,'inspections',$2,$3,$4,'{}',$5,$6)",
      [
        reportIds[index],
        inspection,
        index + 10,
        `sales-scope-report-${index}`,
        admin.id,
        classification,
      ],
    );
  }
  for (const [list, expected, text] of [
    [listDocuments, documentIds, "sales-scope-document"],
    [listReports, reportIds, "sales-scope-report"],
  ] as const) {
    const visible = await list(
      sales,
      query({ customer_id: customer, q: text, limit: "1" }),
    );
    assert.equal(visible.total, 2);
    assert.equal(visible.rows.length, 1);
    const allVisible = await list(
      sales,
      query({ customer_id: customer, q: text }),
    );
    assert.deepEqual(ids(allVisible.rows), expected.slice(0, 2).sort());
    for (const classification of ["network", "restricted"]) {
      const hidden = await list(
        sales,
        query({ customer_id: customer, q: text, classification }),
      );
      assert.equal(hidden.total, 0);
      assert.deepEqual(hidden.rows, []);
    }
    assert.equal(
      (await list(sales, query({ q: text, classification: "financial" })))
        .total,
      1,
    );
  }
});
