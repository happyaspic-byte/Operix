import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "../src/lib/auth.ts";
import type { Database } from "../src/lib/db.ts";
import { AppError } from "../src/lib/policy.ts";
import { saveRecord } from "../src/lib/records.ts";
import { updateVisitPrep, visitPrep } from "../src/lib/visit-prep.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let fixture: { db: Database; close: () => Promise<void> };
let db: Database;
const admin: User = {
  id: "prep-admin",
  email: "prep@example.test",
  name: "준비 관리자",
  role: "admin",
  active: true,
};
const viewer: User = { ...admin, role: "viewer" };
const sales: User = { ...admin, role: "sales" };
let inspectionId: string;
let assetIds: string[];

before(async () => {
  fixture = await isolatedDatabase();
  db = fixture.db;
  await db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test')",
    [admin.id, admin.email, admin.name, admin.role],
  );
  const customer = await saveRecord("customers", admin, {
    name: "준비표 고객",
  });
  const site = await saveRecord("sites", admin, {
    name: "준비표 사업장",
    customer_id: customer.id,
  });
  const a = await saveRecord("assets", admin, {
    name: "준비 자산 A",
    site_id: site.id,
    product: "Server",
  });
  const b = await saveRecord("assets", admin, {
    name: "준비 자산 B",
    site_id: site.id,
    product: "Server",
  });
  assetIds = [a.id, b.id];
  await saveRecord("customer_contacts", admin, {
    customer_id: customer.id,
    name: "가상 담당자",
    phone: "010-0000-0000",
  });
  await saveRecord("inspections", admin, {
    name: "이전 점검",
    asset_ids: assetIds,
    planned_date: "2026-01-01",
    status: "completed",
    result: "양호",
    follow_up: "확인",
  });
  const inspection = await saveRecord("inspections", admin, {
    name: "방문 점검",
    asset_ids: assetIds,
    planned_date: "2026-12-01",
  });
  inspectionId = inspection.id;
  await saveRecord("tickets", admin, {
    customer_id: customer.id,
    name: "열린 작업",
    status: "open",
    asset_ids: [b.id],
  });
  await saveRecord("tickets", admin, {
    customer_id: customer.id,
    name: "종결 작업",
    status: "closed",
    resolution: "처리 완료",
  });
  await saveRecord("contracts", admin, {
    customer_id: customer.id,
    name: "지원 계약",
    kind: "maintenance",
    term: "perpetual",
    asset_ids: assetIds,
  });
  for (const [name, classification, scan] of [
    ["공유", "internal", "clean"],
    ["네트워크", "network", "clean"],
    ["제한", "restricted", "clean"],
    ["미검사", "internal", "pending"],
  ]) {
    await db.query(
      "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by,classification,scan_status) VALUES ($1,'inspections',$2,$3,'text/plain',1,$1,$4,$5,$6)",
      [crypto.randomUUID(), inspectionId, name, admin.id, classification, scan],
    );
  }
});
after(async () => {
  await fixture?.close();
});

test("aggregates all targets, history, coverage and open tickets", async () => {
  const sheet = await visitPrep(inspectionId, admin);
  assert.deepEqual(new Set(sheet.assets.map((a) => a.id)), new Set(assetIds));
  assert.equal(sheet.contacts[0].name, "가상 담당자");
  assert.deepEqual(
    sheet.tickets.map((t) => t.name),
    ["열린 작업"],
  );
  assert.equal(sheet.contracts.length, 2);
  assert.equal(sheet.previous.length, 2);
  assert.equal(sheet.previous[0].result, "양호");
  assert.equal(sheet.documents.length, 3);
});

test("restricted and unscanned documents are not returned to sales or viewers", async () => {
  for (const user of [sales, viewer]) {
    const sheet = await visitPrep(inspectionId, user);
    assert.deepEqual(
      sheet.documents.map((d) => d.name),
      ["공유"],
    );
    assert.equal("updated_at" in sheet.checks[0], false);
  }
});

test("checks persist, enforce permissions and reject unknown keys", async () => {
  await updateVisitPrep(inspectionId, admin, {
    item_key: "contact",
    checked: true,
  });
  const sheet = await visitPrep(inspectionId, admin);
  assert.equal(sheet.checks[0].checked, true);
  assert.equal(sheet.checks[0].updated_by, admin.id);
  assert.ok(sheet.checks[0].updated_at);
  await assert.rejects(
    updateVisitPrep(inspectionId, viewer, {
      item_key: "contact",
      checked: false,
    }),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  await assert.rejects(
    updateVisitPrep(inspectionId, admin, { item_key: "bad", checked: true }),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
});

test("trashed inspections are not accessible", async () => {
  await db.query("UPDATE inspections SET deleted_at=now() WHERE id=$1", [
    inspectionId,
  ]);
  await assert.rejects(
    visitPrep(inspectionId, admin),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
  await assert.rejects(
    updateVisitPrep(inspectionId, admin, {
      item_key: "contact",
      checked: false,
    }),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
});
