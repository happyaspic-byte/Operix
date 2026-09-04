import { NextResponse } from "next/server";
import { assertOrigin, requireUser, audit } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getRecord } from "@/lib/records";
import { AppError, requirePermission } from "@/lib/policy";
import { failure, readJson } from "@/lib/http";
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(
      await (
        await getDb()
      ).query(
        "SELECT r.id,r.title,r.revision,r.entity_kind,r.entity_id,r.created_at,u.name approved_name FROM reports r JOIN users u ON u.id=r.approved_by ORDER BY r.created_at DESC LIMIT 100",
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "reports:approve");
    const b = await readJson(request);
    if (!["inspections", "tickets"].includes(b.entity_kind))
      throw new AppError(400, "보고서 대상을 확인해 주세요.");
    const db = await getDb();
    const report = await db.transaction(async (tx) => {
      await tx.query(`SELECT id FROM ${b.entity_kind} WHERE id=$1 FOR UPDATE`, [
        b.entity_id,
      ]);
      const record = await getRecord(b.entity_kind, b.entity_id, u, tx);
      if (!["completed", "resolved", "closed"].includes(record.status))
        throw new AppError(
          400,
          "완료·해결 상태에서 보고서를 확정할 수 있습니다.",
        );
      const entries = await tx.query(
        "SELECT e.body,e.evidence_level,e.created_at,u.name user_name FROM entries e JOIN users u ON u.id=e.user_id WHERE entity_kind=$1 AND entity_id=$2 ORDER BY e.created_at",
        [b.entity_kind, b.entity_id],
      );
      const documents = await tx.query(
        "SELECT id,name,mime_type,size_bytes FROM documents WHERE entity_kind=$1 AND entity_id=$2 ORDER BY created_at",
        [b.entity_kind, b.entity_id],
      );
      const [max] = await tx.query(
        "SELECT coalesce(max(revision),0)::int revision FROM reports WHERE entity_kind=$1 AND entity_id=$2",
        [b.entity_kind, b.entity_id],
      );
      const id = crypto.randomUUID(),
        revision = max.revision + 1;
      await tx.query(
        "INSERT INTO reports(id,entity_kind,entity_id,revision,title,snapshot,approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          b.entity_kind,
          b.entity_id,
          revision,
          record.name,
          JSON.stringify({ record, entries, documents, approved_name: u.name }),
          u.id,
        ],
      );
      await audit(tx, u.id, "approve_report", b.entity_kind, b.entity_id, {
        revision,
      });
      return { id, revision };
    });
    return NextResponse.json(report, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
