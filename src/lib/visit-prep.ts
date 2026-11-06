import { z } from "zod";
import { audit, type User } from "./auth";
import { getDb, type Database } from "./db";
import { dayDiff } from "./dates";
import { readableClasses } from "./document-policy";
import { AppError, can, requirePermission } from "./policy";
import { getRecord } from "./records";
import { lockBusiness } from "./transactions";

export const prepItems = [
  { key: "contact", label: "담당자 연락 확인" },
  { key: "assets", label: "자산 목록 확인" },
  { key: "tickets", label: "미해결 작업 검토" },
  { key: "contracts", label: "계약 상태 확인" },
  { key: "previous", label: "이전 점검 결과 검토" },
  { key: "documents", label: "필요 자료 준비" },
] as const;

async function inspectionFor(db: Database, id: string, user: User) {
  const [row] = await db.query(
    "SELECT id FROM inspections WHERE id=$1 AND deleted_at IS NULL",
    [id],
  );
  if (!row) throw new AppError(404, "점검을 찾을 수 없습니다.");
  return getRecord("inspections", id, user, db);
}

async function checksFor(db: Database, id: string, user: User) {
  const rows = await db.query(
    "SELECT p.item_key,p.checked,p.updated_by,p.updated_at,u.name updated_by_name FROM visit_prep_checks p LEFT JOIN users u ON u.id=p.updated_by WHERE p.inspection_id=$1",
    [id],
  );
  return prepItems.map((item) => {
    const row = rows.find((r) => r.item_key === item.key);
    return {
      ...item,
      checked: row?.checked ?? false,
      ...(can(user.role, "audit")
        ? {
            updated_by: row?.updated_by ?? null,
            updated_by_name: row?.updated_by_name ?? null,
            updated_at: row?.updated_at ?? null,
          }
        : {}),
    };
  });
}

export async function visitPrep(id: string, user: User) {
  const db = await getDb();
  const inspection = await inspectionFor(db, id, user);
  const assetIds: string[] = inspection.asset_ids;
  const [
    customers,
    sites,
    contacts,
    assets,
    tickets,
    contracts,
    previous,
    checks,
  ] = await Promise.all([
    db.query("SELECT id,name FROM customers WHERE id=$1", [
      inspection.customer_id,
    ]),
    db.query(
      "SELECT DISTINCT s.id,s.name,s.address,s.contact_name,s.phone FROM sites s JOIN assets a ON a.site_id=s.id WHERE a.id=ANY($1::text[]) ORDER BY s.name",
      [assetIds],
    ),
    db.query(
      "SELECT id,site_id,name,department,contact_role,phone,email FROM customer_contacts WHERE customer_id=$1 AND status='active' ORDER BY name,id",
      [inspection.customer_id],
    ),
    db.query(
      "SELECT a.id,a.site_id,a.name,a.asset_tag,a.product,a.model,a.software_version,a.serial,a.protection,a.status FROM assets a WHERE a.id=ANY($1::text[]) ORDER BY a.name,a.id",
      [assetIds],
    ),
    db.query(
      "SELECT DISTINCT t.id,t.name,t.status,t.severity,t.customer_id FROM tickets t LEFT JOIN ticket_assets ta ON ta.ticket_id=t.id WHERE t.status NOT IN ('resolved','closed') AND (t.customer_id=$1 OR ta.asset_id=ANY($2::text[])) ORDER BY t.name,t.id",
      [inspection.customer_id, assetIds],
    ),
    db.query(
      "SELECT c.id,c.name,c.kind,c.term,c.start_date,c.end_date,c.status,c.renewal,c.notice_days,ca.asset_id FROM contracts c JOIN contract_assets ca ON ca.contract_id=c.id WHERE ca.asset_id=ANY($1::text[]) ORDER BY c.name,c.id,ca.asset_id",
      [assetIds],
    ),
    db.query(
      `SELECT DISTINCT ON (linked.asset_id) linked.asset_id,i.id,i.name,i.planned_date,i.completed_at,i.checklist,i.result,i.follow_up
      FROM inspections i JOIN (SELECT inspection_id,asset_id FROM inspection_assets UNION SELECT id,asset_id FROM inspections) linked ON linked.inspection_id=i.id
      WHERE linked.asset_id=ANY($1::text[]) AND i.id<>$2 AND i.status='completed' AND i.deleted_at IS NULL AND i.planned_date <= $3
      ORDER BY linked.asset_id,i.completed_at DESC NULLS LAST,i.planned_date DESC,i.id DESC`,
      [assetIds, id, inspection.planned_date],
    ),
    checksFor(db, id, user),
  ]);
  const coverage = contracts.map((c) => {
    const days = c.term === "dated" && c.end_date ? dayDiff(c.end_date) : null;
    const status =
      c.status === "archived" ||
      c.renewal === "ended" ||
      (days !== null && days < 0)
        ? "expired"
        : c.term === "unknown"
          ? "unknown"
          : days !== null && days <= c.notice_days
            ? "expiring"
            : "active";
    return { ...c, coverage_status: status };
  });
  const kinds = [
    "inspections",
    "customers",
    "sites",
    "assets",
    "tickets",
    "contracts",
  ];
  const ids = [
    [id, ...previous.map((r) => r.id)],
    [inspection.customer_id],
    sites.map((r) => r.id),
    assetIds,
    tickets.map((r) => r.id),
    contracts.map((r) => r.id),
  ];
  const documents = (
    await Promise.all(
      kinds.map((kind, index) =>
        db.query(
          "SELECT id,entity_kind,entity_id,name,mime_type,size_bytes,created_at,classification FROM documents WHERE entity_kind=$1 AND entity_id=ANY($2::text[]) AND deleted_at IS NULL AND scan_status='clean' AND classification=ANY($3::text[]) ORDER BY name,id",
          [kind, ids[index], readableClasses(user.role)],
        ),
      ),
    )
  ).flat();
  return {
    inspection,
    customer: customers[0],
    sites,
    contacts,
    assets,
    tickets,
    contracts: coverage,
    previous,
    documents,
    checks,
    can_edit:
      can(user.role, "work:write") &&
      !(
        user.role === "engineer" &&
        inspection.assignee_id &&
        inspection.assignee_id !== user.id
      ),
  };
}

export async function updateVisitPrep(id: string, user: User, input: unknown) {
  const parsed = z
    .object({
      item_key: z.enum(
        prepItems.map((item) => item.key) as [
          (typeof prepItems)[number]["key"],
          ...(typeof prepItems)[number]["key"][],
        ],
      ),
      checked: z.boolean(),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new AppError(400, "준비 항목과 완료 여부를 확인해 주세요.");
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const inspection = await inspectionFor(tx, id, user);
    requirePermission(user.role, "work:write");
    if (
      user.role === "engineer" &&
      inspection.assignee_id &&
      inspection.assignee_id !== user.id
    )
      throw new AppError(403, "담당 작업만 수정할 수 있습니다.");
    await tx.query(
      "INSERT INTO visit_prep_checks(inspection_id,item_key,checked,updated_by,updated_at) VALUES ($1,$2,$3,$4,now()) ON CONFLICT (inspection_id,item_key) DO UPDATE SET checked=EXCLUDED.checked,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at",
      [id, parsed.data.item_key, parsed.data.checked, user.id],
    );
    await audit(
      tx,
      user.id,
      "visit_prep_check",
      "inspections",
      id,
      parsed.data,
    );
    return { checks: await checksFor(tx, id, user) };
  });
}
