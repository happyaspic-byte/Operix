import { createHash, randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { getDb, type Database } from "./db";
import { audit, type User } from "./auth";
import { AppError } from "./policy";
import { lockBusiness } from "./transactions";
import { documentPath } from "./documents";
import { securityLog } from "./security";
import { persistTombstone } from "./privacy-ledger";
export type SubjectKind = "customers" | "users";
type Inventory = {
  scope: Record<string, string[]>;
  copies: Record<string, string[]>;
  fingerprint: string;
  counts: Record<string, number>;
  backup_count: number;
  external_review_required: true;
};
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function admin(user: User) {
  if (user.role !== "admin")
    throw new AppError(403, "개인정보 관리 권한이 필요합니다.");
}
export async function inventory(
  db: Database,
  kind: SubjectKind,
  id: string,
): Promise<Inventory> {
  if (!["customers", "users"].includes(kind))
    throw new AppError(400, "파기 대상 유형을 확인해 주세요.");
  const [subject] = await db.query(`SELECT * FROM ${kind} WHERE id=$1`, [id]);
  if (!subject) throw new AppError(404, "파기 대상을 찾을 수 없습니다.");
  const scope: Record<string, string[]> = { [kind]: [id] },
    records: unknown[] = [subject];
  async function collect(table: string, sql: string, params: unknown[]) {
    const rows = await db.query(sql, params);
    scope[table] = rows.map((r) => r.id);
    records.push(rows);
  }
  if (kind === "customers") {
    await collect(
      "sites",
      "SELECT * FROM sites WHERE customer_id=$1 ORDER BY id",
      [id],
    );
    await collect(
      "assets",
      "SELECT * FROM assets WHERE site_id=ANY($1::text[]) ORDER BY id",
      [scope.sites],
    );
    for (const table of ["components", "vms", "maintenance_plans"])
      await collect(
        table,
        `SELECT * FROM ${table} WHERE asset_id=ANY($1::text[]) ORDER BY id`,
        [scope.assets],
      );
    await collect(
      "inspections",
      "SELECT i.* FROM inspections i WHERE i.asset_id=ANY($1::text[]) OR EXISTS (SELECT 1 FROM inspection_assets ia WHERE ia.inspection_id=i.id AND ia.asset_id=ANY($1::text[])) ORDER BY i.id",
      [scope.assets],
    );
    records.push(
      await db.query(
        "SELECT inspection_id,asset_id FROM inspection_assets WHERE inspection_id=ANY($1::text[]) ORDER BY inspection_id,asset_id",
        [scope.inspections],
      ),
    );
    for (const table of ["contracts", "tickets", "customer_contacts"])
      await collect(
        table,
        `SELECT * FROM ${table} WHERE customer_id=$1 ORDER BY id`,
        [id],
      );
  }
  records.push(
    await db.query("SELECT * FROM privacy_policies ORDER BY resource_kind"),
  );
  const scopeIds = Object.values(scope).flat(),
    customerIds = kind === "customers" ? [id] : [];
  const held = await db.query(
    "SELECT id FROM privacy_holds WHERE active=true AND ((subject_kind=$1 AND subject_id=$2) OR (subject_kind='customers' AND subject_id=ANY($3::text[])))",
    [kind, id, customerIds],
  );
  if (held.length)
    throw new AppError(
      409,
      "보존 예외가 등록되어 있습니다. 보존 근거를 검토하고 예외를 해제한 뒤 진행해 주세요.",
    );
  const copies: Record<string, string[]> = {};
  const copySources = new Set<string>(scopeIds),
    copyUsers = new Set<string>();
  async function copy(table: string, where: string, values: unknown[]) {
    const rows = await db.query(
      `SELECT * FROM ${table} WHERE ${where} ORDER BY id`,
      values,
    );
    copies[table] = rows.map((r) => r.id);
    for (const row of rows) {
      if (row.entity_id) copySources.add(row.entity_id);
      for (const key of ["user_id", "uploaded_by", "approved_by"])
        if (row[key]) copyUsers.add(row[key]);
    }
    records.push(rows);
  }
  await copy(
    "documents",
    "entity_id=ANY($1::text[]) OR ($2='users' AND uploaded_by=$3)",
    [scopeIds, kind, id],
  );
  await copy(
    "entries",
    "entity_id=ANY($1::text[]) OR ($2='users' AND user_id=$3)",
    [scopeIds, kind, id],
  );
  // Names/emails copied into historical snapshots are included in user erasure review.
  await copy(
    "reports",
    "entity_id=ANY($1::text[]) OR ($2='users' AND (approved_by=$3 OR position($3 in snapshot::text)>0 OR position($4 in snapshot::text)>0 OR position($5 in snapshot::text)>0))",
    [
      scopeIds,
      kind,
      id,
      subject.name || "__absent__",
      subject.email || "__absent__",
    ],
  );
  await copy(
    "audit_logs",
    "entity_id=ANY($1::text[]) OR ($2='users' AND user_id=$3)",
    [scopeIds, kind, id],
  );
  // Pending spreadsheets may contain unstructured copies; invalidate previews on erasure.
  await copy("import_batches", "payload<>'[]'::jsonb", []);
  await copy(
    "notifications",
    "source_id=ANY($1::text[]) OR ($2='users' AND user_id=$3)",
    [scopeIds, kind, id],
  );
  const otherHolds = await db.query(
    "SELECT subject_kind,subject_id FROM privacy_holds WHERE active=true",
  );
  for (const h of otherHolds) {
    if (h.subject_kind === "users" && copyUsers.has(h.subject_id))
      throw new AppError(
        409,
        "연결된 사용자 기록에 보존 예외가 있습니다. 파기 범위를 검토해 주세요.",
      );
    if (h.subject_kind === "customers") {
      const roots = await db.query(
        "SELECT id FROM customers WHERE id=$1 UNION SELECT id FROM sites WHERE customer_id=$1 UNION SELECT id FROM contracts WHERE customer_id=$1 UNION SELECT id FROM tickets WHERE customer_id=$1 UNION SELECT id FROM customer_contacts WHERE customer_id=$1 UNION SELECT a.id FROM assets a JOIN sites s ON s.id=a.site_id WHERE s.customer_id=$1 UNION SELECT i.id FROM inspections i JOIN assets a ON a.id=i.asset_id OR EXISTS (SELECT 1 FROM inspection_assets ia WHERE ia.inspection_id=i.id AND ia.asset_id=a.id) JOIN sites s ON s.id=a.site_id WHERE s.customer_id=$1",
        [h.subject_id],
      );
      if (roots.some((r) => copySources.has(r.id)))
        throw new AppError(
          409,
          "파기할 사본이 보존 예외 고객에 연결되어 있습니다. 범위를 검토해 주세요.",
        );
    }
  }
  const backups = await db.query(
    "SELECT id,status,manifest_hash,expires_at FROM backup_runs WHERE expires_at IS NULL OR expires_at>now() ORDER BY id",
  );
  records.push(backups);
  const counts = Object.fromEntries(
    [...Object.entries(scope), ...Object.entries(copies)].map(([k, v]) => [
      k,
      v.length,
    ]),
  );
  return {
    scope,
    copies,
    counts,
    fingerprint: digest(records),
    backup_count: backups.length,
    external_review_required: true,
  };
}
export async function previewErasure(
  user: User,
  kind: SubjectKind,
  id: string,
  reason: string,
  basis: string,
) {
  admin(user);
  if (kind === "users" && id === user.id)
    throw new AppError(400, "현재 관리자 계정은 파기할 수 없습니다.");
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const [policy] = await tx.query(
      "SELECT * FROM privacy_policies WHERE resource_kind=$1 AND approved_at IS NOT NULL",
      [kind],
    );
    if (!policy)
      throw new AppError(
        409,
        "대상 개인정보의 처리 목적·보유 정책을 먼저 등록해 주세요.",
      );
    const [subject] = await tx.query(`SELECT * FROM ${kind} WHERE id=$1`, [id]);
    if (!subject) throw new AppError(404, "대상을 찾을 수 없습니다.");
    if (kind === "customers" ? subject.status !== "archived" : subject.active)
      throw new AppError(
        409,
        "고객 보관 또는 계정 정지 후 파기 검토를 진행해 주세요.",
      );
    if (subject.privacy_erased_at)
      throw new AppError(410, "이미 파기 처리된 대상입니다.");
    const inv = await inventory(tx, kind, id),
      requestId = crypto.randomUUID();
    await tx.query(
      "INSERT INTO privacy_requests(id,subject_kind,subject_id,reason,lawful_basis,inventory,inventory_hash,created_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '30 minutes')",
      [
        requestId,
        kind,
        id,
        reason,
        basis,
        JSON.stringify(inv),
        digest(inv),
        user.id,
      ],
    );
    return { id: requestId, ...inv };
  });
}
async function applyErasure(
  tx: Database,
  kind: SubjectKind,
  id: string,
  inv: Inventory,
) {
  const pseudo = "파기-" + id.slice(0, 8),
    scope = inv.scope,
    copies = inv.copies;
  if (kind === "customers") {
    await tx.query(
      "UPDATE customers SET name=$2,contact_name='',email='',phone='',notes='',industry='',status='archived',privacy_erased_at=now(),version=version+1,updated_at=now() WHERE id=$1",
      [id, pseudo],
    );
    await tx.query(
      "UPDATE customer_contacts SET name='파기-'||id,department='',email='',phone='',notes='',status='archived',privacy_erased_at=now(),version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.customer_contacts],
    );
    for (const table of [
      "sites",
      "assets",
      "components",
      "vms",
      "contracts",
      "maintenance_plans",
      "inspections",
      "tickets",
    ])
      await tx.query(
        `UPDATE ${table} SET privacy_erased_at=now() WHERE id=ANY($1::text[])`,
        [scope[table]],
      );
    await tx.query(
      "UPDATE sites SET name='파기-'||id,address='',contact_name='',phone='',notes='',status='archived',version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.sites],
    );
    await tx.query(
      "UPDATE assets SET name='파기-'||id,asset_tag=NULL,model='',serial='',management_ip='',network_notes='',notes='',owner_id=NULL,status='archived',version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.assets],
    );
    for (const table of ["components", "vms"])
      await tx.query(
        `UPDATE ${table} SET name='파기-'||id,notes='',${table === "components" ? "role='',model='',serial=''" : "purpose='',os=''"},version=version+1,updated_at=now() WHERE id=ANY($1::text[])`,
        [scope[table]],
      );
    await tx.query(
      "UPDATE contracts SET name='파기-'||id,counterparty='',notes='',owner_id=NULL,status='archived',version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.contracts],
    );
    await tx.query(
      "UPDATE maintenance_plans SET name='파기-'||id,checklist='[]',assignee_id=NULL,status='archived',version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.maintenance_plans],
    );
    await tx.query(
      "UPDATE inspections SET name='파기-'||id,checklist='[]',result='',follow_up='',assignee_id=NULL,status=CASE WHEN status='scheduled' THEN 'cancelled' ELSE status END,version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.inspections],
    );
    await tx.query(
      "UPDATE tickets SET name='파기-'||id,description='',vendor_case='',resolution='',assignee_id=NULL,version=version+1,updated_at=now() WHERE id=ANY($1::text[])",
      [scope.tickets],
    );
  } else {
    await tx.query(
      "UPDATE users SET name=$2,email=$3,password_hash=$4,active=false,must_change_password=true,privacy_erased_at=now(),version=version+1,updated_at=now() WHERE id=$1",
      [
        id,
        pseudo,
        id + "@erased.invalid",
        "erased:" + randomBytes(32).toString("hex"),
      ],
    );
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
  }
  await tx.query(
    "UPDATE entries SET body='개인정보 파기로 삭제',customer_visible=false WHERE id=ANY($1::text[])",
    [copies.entries],
  );
  await tx.query(
    "UPDATE reports SET title='개인정보 파기로 철회',snapshot='{}',issue_reason='',withdrawn_at=now() WHERE id=ANY($1::text[])",
    [copies.reports],
  );
  await tx.query(
    "UPDATE documents SET name='개인정보 파기로 삭제',deleted_at=now(),version=version+1 WHERE id=ANY($1::text[])",
    [copies.documents],
  );
  await tx.query(
    "DELETE FROM download_grants WHERE document_id=ANY($1::text[])",
    [copies.documents],
  );
  await tx.query(
    "UPDATE audit_logs SET details=jsonb_build_object('redacted',true) WHERE id=ANY($1::text[])",
    [copies.audit_logs],
  );
  await tx.query(
    "UPDATE import_batches SET payload='[]',expires_at=now() WHERE id=ANY($1::text[])",
    [copies.import_batches],
  );
  await tx.query("DELETE FROM notifications WHERE id=ANY($1::text[])", [
    copies.notifications,
  ]);
}
export async function executeErasure(user: User, requestId: string) {
  admin(user);
  const db = await getDb();
  const result = await db.transaction(async (tx) => {
    await lockBusiness(tx);
    const [r] = await tx.query(
      "SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE",
      [requestId],
    );
    if (
      !r ||
      r.state !== "preview" ||
      new Date(r.expires_at).getTime() < Date.now()
    )
      throw new AppError(409, "유효한 파기 미리보기를 다시 생성해 주세요.");
    const inv = await inventory(tx, r.subject_kind, r.subject_id);
    if (digest(inv) !== r.inventory_hash)
      throw new AppError(
        409,
        "대상이나 사본이 변경되었습니다. 다시 미리보기를 확인해 주세요.",
      );
    await applyErasure(tx, r.subject_kind, r.subject_id, inv);
    const tombstone = {
      id: crypto.randomUUID(),
      subject_kind: r.subject_kind,
      subject_id: r.subject_id,
      request_id: r.id,
      erased_at: new Date().toISOString(),
    };
    // Durable erasure intent survives rollback or loss of the application database.
    await persistTombstone(tombstone);
    await tx.query(
      "INSERT INTO privacy_tombstones(id,subject_kind,subject_id,request_id,erased_at) VALUES ($1,$2,$3,$4,$5)",
      [tombstone.id, r.subject_kind, r.subject_id, r.id, tombstone.erased_at],
    );
    await tx.query(
      "UPDATE privacy_requests SET state='pending_files',executed_at=now() WHERE id=$1",
      [r.id],
    );
    await audit(tx, user.id, "privacy_erasure", r.subject_kind, r.subject_id, {
      request_id: r.id,
    });
    return { id: r.id, state: "pending_files" };
  });
  await purgeDeletedFiles();
  await securityLog(user, {
    action: "privacy_erasure",
    kind: "privacy_requests",
    ids: [requestId],
  });
  return result;
}
export async function purgeDeletedFiles() {
  const db = await getDb(),
    docs = await db.query(
      "SELECT id,storage_key FROM documents WHERE deleted_at IS NOT NULL AND purged_at IS NULL LIMIT 100",
    );
  for (const d of docs) {
    try {
      await unlink(documentPath(d.storage_key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    await db.query("UPDATE documents SET purged_at=now() WHERE id=$1", [d.id]);
  }
  const pending = await db.query(
    "SELECT id,inventory FROM privacy_requests WHERE state='pending_files'",
  );
  for (const r of pending) {
    const [c] = await db.query(
      "SELECT count(*)::int n FROM documents WHERE id=ANY($1::text[]) AND purged_at IS NULL",
      [r.inventory.copies.documents],
    );
    if (!c.n)
      await db.query(
        "UPDATE privacy_requests SET state='pending_backups' WHERE id=$1",
        [r.id],
      );
  }
  return docs.length;
}
export async function replayTombstones(
  tombstones: {
    subject_kind: SubjectKind;
    subject_id: string;
    request_id: string;
    id: string;
    erased_at: string;
  }[],
) {
  const db = await getDb();
  for (const t of tombstones) {
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const rows = await tx.query(
        `SELECT id FROM ${t.subject_kind === "customers" ? "customers" : "users"} WHERE id=$1`,
        [t.subject_id],
      );
      if (!rows.length) return;
      const inv = await inventory(tx, t.subject_kind, t.subject_id);
      await applyErasure(tx, t.subject_kind, t.subject_id, inv);
      await tx.query(
        "INSERT INTO privacy_tombstones(id,subject_kind,subject_id,request_id,erased_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [t.id, t.subject_kind, t.subject_id, t.request_id, t.erased_at],
      );
    });
  }
  await purgeDeletedFiles();
}
