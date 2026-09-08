import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "../src/lib/auth.ts";
import type { Database } from "../src/lib/db.ts";
import {
  classifyDocument,
  createDownloadGrant,
  downloadDocument,
  listDocuments,
  uploadDocument,
} from "../src/lib/documents.ts";
import { saveRecord, setInspectionDeleted } from "../src/lib/records.ts";
import { createReport, getReport } from "../src/lib/reports.ts";
import { AppError } from "../src/lib/policy.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let db: Database;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
let directory: string | undefined;
const environment = [
  "UPLOAD_DIR",
  "SECURITY_LOG_DIR",
  "SECURITY_LOG_KEY",
  "FILE_SCAN_MODE",
  "APP_URL",
  "UPLOAD_STORAGE_LIMIT_MB",
] as const;
const previous = Object.fromEntries(
  environment.map((key) => [key, process.env[key]]),
);
const admin: User = {
  id: crypto.randomUUID(),
  email: "deleted-inspection-documents-admin@example.test",
  name: "Attachment administrator",
  role: "admin",
  active: true,
};
const manager: User = {
  ...admin,
  id: crypto.randomUUID(),
  email: "attachment-manager@example.test",
  name: "Attachment manager",
  role: "manager",
};
const engineer: User = {
  ...admin,
  id: crypto.randomUUID(),
  email: "attachment-engineer@example.test",
  name: "Attachment engineer",
  role: "engineer",
};
const viewer: User = {
  ...admin,
  id: crypto.randomUUID(),
  email: "attachment-viewer@example.test",
  name: "Attachment viewer",
  role: "viewer",
};
const content = "Synthetic evidence preserved after inspection deletion.";

before(async () => {
  directory = await mkdtemp(
    join(tmpdir(), "operix-deleted-inspection-documents-"),
  );
  process.env.UPLOAD_DIR = join(directory, "uploads");
  process.env.SECURITY_LOG_DIR = join(directory, "security");
  process.env.SECURITY_LOG_KEY =
    "deleted-inspection-document-isolated-signing-key";
  process.env.FILE_SCAN_MODE = "test";
  process.env.APP_URL = "http://localhost";
  process.env.UPLOAD_STORAGE_LIMIT_MB = "128";
  fixture = await isolatedDatabase();
  db = fixture.db;
  for (const user of [admin, manager, engineer, viewer])
    await db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'unused-test-password')",
      [user.id, user.email, user.name, user.role],
    );
});

after(async () => {
  try {
    await fixture?.close();
  } finally {
    for (const key of environment) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function inspection() {
  const customer = await saveRecord("customers", admin, {
    name: "Attachment customer " + crypto.randomUUID(),
  });
  const site = await saveRecord("sites", admin, {
    name: "Attachment site",
    customer_id: customer.id,
  });
  const asset = await saveRecord("assets", admin, {
    name: "Attachment asset",
    site_id: site.id,
    product: "Server",
  });
  return saveRecord("inspections", admin, {
    name: "Attachment inspection",
    asset_ids: [asset.id],
    planned_date: "2026-10-01",
    status: "completed",
    result: "Synthetic verified result",
  });
}

function form(id: string, classification = "internal") {
  const data = new FormData();
  data.set("entity_kind", "inspections");
  data.set("entity_id", id);
  data.set("classification", classification);
  data.set("file", new File([content], "synthetic-evidence.txt"));
  return data;
}

const status = (expected: number) => (error: unknown) =>
  error instanceof AppError && error.status === expected;

async function storedDocument(id: string) {
  const [doc] = await db.query("SELECT * FROM documents WHERE id=$1", [id]);
  assert.ok(doc);
  return doc;
}

async function grants(id: string) {
  return db.query(
    "SELECT * FROM download_grants WHERE document_id=$1 ORDER BY id",
    [id],
  );
}

async function deletedDocument(classification = "internal") {
  const row = await inspection();
  const doc = await uploadDocument(admin, form(row.id, classification));
  assert.equal(doc.scan_status, "clean");
  const deleted = await setInspectionDeleted(
    admin,
    row.id,
    { version: row.version },
    true,
  );
  return { row, deleted, doc };
}

test("An administrator can download existing clean evidence after its inspection is deleted", async () => {
  const row = await inspection();
  const doc = await uploadDocument(admin, form(row.id));
  assert.equal(doc.scan_status, "clean");
  await setInspectionDeleted(admin, row.id, { version: row.version }, true);
  const result = await downloadDocument(admin, doc.id, new URLSearchParams());
  assert.equal(await new Response(result.stream).text(), content);
});

test("A manager can download existing internal evidence from a deleted inspection", async () => {
  const { doc } = await deletedDocument();
  const result = await downloadDocument(manager, doc.id, new URLSearchParams());
  assert.equal(await new Response(result.stream).text(), content);
});

test("Engineers and viewers cannot download evidence or request grants for a deleted inspection", async () => {
  const { doc } = await deletedDocument();
  for (const user of [engineer, viewer]) {
    await assert.rejects(
      () => downloadDocument(user, doc.id, new URLSearchParams()),
      status(403),
    );
    await assert.rejects(
      () =>
        createDownloadGrant(user, doc.id, "Synthetic deleted evidence review"),
      status(403),
    );
  }
  // Engineers can ordinarily read network documents, so this rejection must also enforce the parent inspection's deletion.
  const network = await deletedDocument("network");
  await assert.rejects(
    () =>
      createDownloadGrant(
        engineer,
        network.doc.id,
        "Synthetic network evidence review",
      ),
    status(403),
  );
  assert.deepEqual(await grants(doc.id), []);
  assert.deepEqual(await grants(network.doc.id), []);
});

test("Sensitive evidence on deleted inspections still requires a single-use grant for administrators and managers", async () => {
  const { doc } = await deletedDocument("network");
  for (const user of [admin, manager]) {
    await assert.rejects(
      () => downloadDocument(user, doc.id, new URLSearchParams()),
      status(403),
    );
    const grant = await createDownloadGrant(
      user,
      doc.id,
      "Synthetic retained evidence review",
    );
    const query = new URL(grant.url, "http://localhost").searchParams;
    const result = await downloadDocument(user, doc.id, query);
    assert.equal(await new Response(result.stream).text(), content);
    await assert.rejects(
      () => downloadDocument(user, doc.id, query),
      status(403),
    );
  }
  assert.deepEqual(await grants(doc.id), []);
});

test("Deleted parent access does not bypass quarantine or document erasure", async () => {
  const { doc } = await deletedDocument();
  for (const scanStatus of ["pending", "infected", "error"]) {
    await db.query("UPDATE documents SET scan_status=$2 WHERE id=$1", [
      doc.id,
      scanStatus,
    ]);
    await assert.rejects(
      () => downloadDocument(admin, doc.id, new URLSearchParams()),
      status(423),
    );
    await assert.rejects(
      () => createDownloadGrant(admin, doc.id, "Synthetic quarantine review"),
      status(423),
    );
  }
  await db.query(
    "UPDATE documents SET scan_status='clean',deleted_at=now() WHERE id=$1",
    [doc.id],
  );
  await assert.rejects(
    () => downloadDocument(admin, doc.id, new URLSearchParams()),
    status(410),
  );
  await assert.rejects(
    () =>
      createDownloadGrant(admin, doc.id, "Synthetic erased evidence review"),
    status(410),
  );
});

test("A deleted inspection rejects new attachments without writing metadata or file bytes", async () => {
  const { row, doc } = await deletedDocument();
  const filesBefore = (await readdir(process.env.UPLOAD_DIR!)).sort();
  for (const user of [admin, manager])
    await assert.rejects(() => uploadDocument(user, form(row.id)), status(410));
  const records = await db.query(
    "SELECT id FROM documents WHERE entity_kind='inspections' AND entity_id=$1",
    [row.id],
  );
  assert.deepEqual(
    records.map((record) => record.id),
    [doc.id],
  );
  assert.deepEqual(
    (await readdir(process.env.UPLOAD_DIR!)).sort(),
    filesBefore,
  );
});

test("A deleted inspection cannot issue a new report", async () => {
  const { row } = await deletedDocument();
  await assert.rejects(
    () =>
      createReport(admin, {
        entity_kind: "inspections",
        entity_id: row.id,
        audience: "internal",
        issue_reason: "Synthetic issue after deletion",
      }),
    status(410),
  );
  assert.deepEqual(
    await db.query(
      "SELECT id FROM reports WHERE entity_kind='inspections' AND entity_id=$1",
      [row.id],
    ),
    [],
  );
});

test("An existing report retains its snapshot and usable evidence links after its inspection is deleted", async () => {
  const row = await inspection();
  const doc = await uploadDocument(admin, form(row.id));
  const issued = await createReport(admin, {
    entity_kind: "inspections",
    entity_id: row.id,
    audience: "customer",
    issue_reason: "Synthetic approved evidence report",
  });
  const before = await getReport(admin, issued.id);
  assert.deepEqual(
    before.snapshot.documents.map((entry: { id: string }) => entry.id),
    [doc.id],
  );
  await setInspectionDeleted(admin, row.id, { version: row.version }, true);
  for (const user of [admin, manager]) {
    const report = await getReport(user, issued.id);
    assert.deepEqual(report.snapshot.record, before.snapshot.record);
    assert.equal(report.snapshot.record.result, "Synthetic verified result");
    assert.equal(report.revision, before.revision);
    assert.deepEqual(
      report.snapshot.documents.map((entry: { id: string }) => entry.id),
      [doc.id],
    );
    const download = await downloadDocument(
      user,
      report.snapshot.documents[0].id,
      new URLSearchParams(),
    );
    assert.equal(await new Response(download.stream).text(), content);
  }
  const [stored] = await db.query(
    "SELECT snapshot,withdrawn_at FROM reports WHERE id=$1",
    [issued.id],
  );
  assert.deepEqual(stored.snapshot.record, before.snapshot.record);
  assert.equal(stored.withdrawn_at, null);
});

for (const rescan of [false, true]) {
  test(`A deleted inspection rejects document ${rescan ? "rescan" : "classification"} without changing the document or grants`, async () => {
    const { doc } = await deletedDocument();
    await createDownloadGrant(admin, doc.id, "Synthetic retained grant review");
    const before = await storedDocument(doc.id);
    const granted = await grants(doc.id);
    assert.equal(granted.length, 1);
    await assert.rejects(
      () =>
        classifyDocument(admin, doc.id, {
          classification: rescan ? "internal" : "restricted",
          version: before.version,
          rescan,
        }),
      status(410),
    );
    assert.deepEqual(await storedDocument(doc.id), before);
    assert.deepEqual(await grants(doc.id), granted);
    assert.deepEqual(
      await db.query(
        "SELECT id FROM audit_logs WHERE action='classify' AND entity_id=$1",
        [doc.id],
      ),
      [],
    );
  });
}

test("Restoring the inspection permits classification and rescan while preserving optimistic version checks", async () => {
  const { row, deleted, doc } = await deletedDocument();
  const before = await storedDocument(doc.id);
  await createDownloadGrant(
    admin,
    doc.id,
    "Synthetic grant before restoration",
  );
  await setInspectionDeleted(
    admin,
    row.id,
    { version: deleted.version },
    false,
  );
  assert.deepEqual(
    await classifyDocument(manager, doc.id, {
      classification: "restricted",
      version: before.version,
      rescan: true,
    }),
    { ok: true },
  );
  const changed = await storedDocument(doc.id);
  assert.equal(changed.classification, "restricted");
  assert.equal(changed.scan_status, "pending");
  assert.equal(changed.version, before.version + 1);
  assert.deepEqual(await grants(doc.id), []);
  await assert.rejects(
    () =>
      classifyDocument(manager, doc.id, {
        classification: "internal",
        version: before.version,
      }),
    status(409),
  );
  assert.deepEqual(await storedDocument(doc.id), changed);
});

test("Document classification still rejects unauthorized roles and invalid versions on a live inspection", async () => {
  const row = await inspection();
  const doc = await uploadDocument(admin, form(row.id));
  const before = await storedDocument(doc.id);
  for (const user of [engineer, viewer])
    await assert.rejects(
      () =>
        classifyDocument(user, doc.id, {
          classification: "internal",
          version: before.version,
        }),
      status(403),
    );
  for (const version of [0, -1, 1.5])
    await assert.rejects(
      () =>
        classifyDocument(admin, doc.id, {
          classification: "internal",
          version,
        }),
      status(400),
    );
  assert.deepEqual(await storedDocument(doc.id), before);
});

test("Concurrent classification and inspection deletion respect the business transaction order", async () => {
  for (const deleteFirst of [false, true]) {
    const row = await inspection();
    const doc = await uploadDocument(admin, form(row.id));
    const before = await storedDocument(doc.id);
    const remove = () =>
      setInspectionDeleted(admin, row.id, { version: row.version }, true);
    const classify = () =>
      classifyDocument(admin, doc.id, {
        classification: "restricted",
        version: before.version,
      });
    const results = await Promise.allSettled(
      deleteFirst ? [remove(), classify()] : [classify(), remove()],
    );
    const deletion = results[deleteFirst ? 0 : 1];
    const classification = results[deleteFirst ? 1 : 0];
    assert.equal(deletion.status, "fulfilled");
    const changed = await storedDocument(doc.id);
    if (classification.status === "fulfilled") {
      assert.equal(changed.classification, "restricted");
      assert.equal(changed.version, before.version + 1);
    } else {
      assert.ok(status(410)(classification.reason));
      assert.deepEqual(changed, before);
    }
    await assert.rejects(
      () =>
        classifyDocument(admin, doc.id, {
          classification: "internal",
          version: changed.version,
        }),
      status(410),
    );
  }
});

test("Document list marks deleted parent inspections and clears the marker after restoration", async () => {
  const { row, deleted, doc } = await deletedDocument();
  const normal = await inspection();
  const normalDoc = await uploadDocument(admin, form(normal.id));
  const list = await listDocuments(
    admin,
    new URLSearchParams({ entity_kind: "inspections", limit: "100" }),
  );
  const marked = list.rows.find((entry) => entry.id === doc.id);
  assert.ok(marked);
  assert.ok(marked.entity_deleted_at);
  assert.equal(marked.entity_deleted_at, deleted.deleted_at);
  const unmarked = list.rows.find((entry) => entry.id === normalDoc.id);
  assert.ok(unmarked);
  assert.equal(unmarked.entity_deleted_at, null);
  await setInspectionDeleted(
    admin,
    row.id,
    { version: deleted.version },
    false,
  );
  const restored = await listDocuments(
    admin,
    new URLSearchParams({ entity_kind: "inspections", entity_id: row.id }),
  );
  assert.equal(restored.total, 1);
  assert.equal(restored.rows[0].id, doc.id);
  assert.equal(restored.rows[0].entity_deleted_at, null);
});
