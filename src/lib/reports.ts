import { z } from "zod";
import { getDb, type Database } from "./db";
import { audit, type User } from "./auth";
import { AppError, requirePermission } from "./policy";
import { canReadClass, readableClasses } from "./document-policy";
import { parseInput, pagination, queryDate } from "./http";
import { getRecord } from "./records";
import { lockBusiness } from "./transactions";
export async function listReports(
  user: User,
  q: URLSearchParams,
  db?: Database,
) {
  db ||= await getDb();
  const p = pagination(q),
    values: unknown[] = [readableClasses(user.role)],
    where = ["r.withdrawn_at IS NULL", "r.classification=ANY($1::text[])"];
  for (const key of ["entity_kind", "entity_id", "audience"])
    if (q.get(key)) {
      values.push(q.get(key));
      where.push(`r.${key}=$${values.length}`);
    }
  if (q.get("q")) {
    values.push("%" + q.get("q")!.slice(0, 150) + "%");
    where.push(`r.title ILIKE $${values.length}`);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<="],
  ])
    if (q.get(key)) {
      values.push(queryDate(q.get(key)!));
      where.push(`r.created_at::date${op}$${values.length}::date`);
    }
  const filter = where.join(" AND "),
    [count] = await db.query(
      "SELECT count(*)::int total FROM reports r WHERE " + filter,
      values,
    );
  const rows = await db.query(
    `SELECT r.id,r.title,r.revision,r.entity_kind,r.entity_id,r.created_at,r.audience,r.classification,r.document_number,u.name approved_name FROM reports r JOIN users u ON u.id=r.approved_by WHERE ${filter} ORDER BY r.created_at DESC,r.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, p.limit, p.offset],
  );
  return { rows, total: count.total, page: p.page, limit: p.limit };
}
export async function createReport(user: User, input: unknown) {
  requirePermission(user.role, "reports:approve");
  const b = parseInput(
      z
        .object({
          entity_kind: z.enum(["inspections", "tickets"]),
          entity_id: z.string().uuid(),
          audience: z.enum(["internal", "customer"]).default("internal"),
          issue_reason: z.string().trim().min(5).max(500),
        })
        .strict(),
      input,
    ),
    db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const record = await getRecord(b.entity_kind, b.entity_id, user, tx);
    if (!["completed", "resolved", "closed"].includes(record.status))
      throw new AppError(
        400,
        "완료·해결 상태에서 보고서를 확정할 수 있습니다.",
      );
    const customer = b.audience === "customer";
    if (customer && record.evidence_level === "internal")
      throw new AppError(
        400,
        "내부 추정 결과는 고객 제출 보고서에 포함할 수 없습니다. 근거를 먼저 확인해 주세요.",
      );
    const entries = await tx.query(
      `SELECT e.user_id,e.body,e.evidence_level,e.created_at,u.name user_name FROM entries e JOIN users u ON u.id=e.user_id WHERE entity_kind=$1 AND entity_id=$2 ${customer ? "AND e.customer_visible=true AND e.evidence_level<>'internal'" : ""} ORDER BY e.created_at,e.id`,
      [b.entity_kind, b.entity_id],
    );
    const documents = await tx.query(
      `SELECT id,name,mime_type,size_bytes,classification,scan_status FROM documents WHERE entity_kind=$1 AND entity_id=$2 AND deleted_at IS NULL AND scan_status='clean' AND classification=ANY($3::text[]) ORDER BY created_at,id`,
      [
        b.entity_kind,
        b.entity_id,
        customer ? ["internal"] : readableClasses(user.role),
      ],
    );
    if (b.entity_kind === "tickets") {
      const assets = await tx.query(
        "SELECT a.id,a.name,a.asset_tag FROM ticket_assets t JOIN assets a ON a.id=t.asset_id WHERE t.ticket_id=$1 ORDER BY a.name",
        [b.entity_id],
      );
      record.asset_name = assets
        .map((a) => a.name + (a.asset_tag ? " (" + a.asset_tag + ")" : ""))
        .join(", ");
    }
    // Explicit fields prevent a future internal column from silently entering customer output.
    const publicFields = [
      "name",
      "customer_name",
      "asset_name",
      "assignee_name",
      "status",
      "planned_date",
      "created_at",
      "resolved_at",
      "closed_at",
      "result",
      "resolution",
      "evidence_level",
      "checklist",
    ];
    const snapshotRecord = customer
      ? Object.fromEntries(
          publicFields.filter((k) => k in record).map((k) => [k, record[k]]),
        )
      : record;
    const [max] = await tx.query(
      "SELECT coalesce(max(revision),0)::int revision FROM reports WHERE entity_kind=$1 AND entity_id=$2",
      [b.entity_kind, b.entity_id],
    );
    const id = crypto.randomUUID(),
      revision = max.revision + 1,
      documentNumber =
        "OPX-" +
        new Date().toISOString().slice(0, 10).replaceAll("-", "") +
        "-" +
        id.slice(0, 8).toUpperCase();
    await tx.query(
      "INSERT INTO reports(id,entity_kind,entity_id,revision,title,snapshot,approved_by,classification,audience,issue_reason,document_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        id,
        b.entity_kind,
        b.entity_id,
        revision,
        record.name,
        JSON.stringify({
          record: snapshotRecord,
          entries,
          documents,
          approved_name: user.name,
        }),
        user.id,
        customer ? "internal" : "restricted",
        b.audience,
        b.issue_reason,
        documentNumber,
      ],
    );
    await audit(tx, user.id, "approve_report", b.entity_kind, b.entity_id, {
      revision,
      report_id: id,
      audience: b.audience,
    });
    return { id, revision, document_number: documentNumber };
  });
}
export async function getReport(user: User, id: string) {
  const db = await getDb(),
    [r] = await db.query(
      "SELECT * FROM reports WHERE id=$1 AND withdrawn_at IS NULL",
      [id],
    );
  if (!r) throw new AppError(404, "보고서를 찾을 수 없습니다.");
  if (!canReadClass(user.role, r.classification))
    throw new AppError(403, "보고서 열람 권한이 없습니다.");
  const allowed = await db.query(
    "SELECT id,name,classification,scan_status FROM documents WHERE id=ANY($1::text[]) AND deleted_at IS NULL AND scan_status='clean' AND classification=ANY($2::text[])",
    [
      (r.snapshot.documents || []).map((d: { id: string }) => d.id),
      readableClasses(user.role),
    ],
  );
  const byId = new Map(allowed.map((d) => [d.id, d]));
  r.snapshot.documents = (r.snapshot.documents || [])
    .filter((d: { id: string }) => byId.has(d.id))
    .map((d: { id: string }) => ({ ...d, ...byId.get(d.id) }));
  return r;
}
