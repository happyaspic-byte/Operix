import { NextResponse } from "next/server";
import { assertOrigin, requireUser, audit } from "@/lib/auth";
import { getRecord } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError, requirePermission } from "@/lib/policy";
import { failure, readJson } from "@/lib/http";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "work:write");
    const b = await readJson(request);
    if (
      !["inspections", "tickets"].includes(b.entity_kind) ||
      typeof b.body !== "string" ||
      !b.body.trim() ||
      b.body.length > 10000 ||
      !["observed", "internal", "vendor"].includes(b.evidence_level)
    )
      throw new AppError(400, "기록 내용과 근거 구분을 확인해 주세요.");
    const rec = await getRecord(b.entity_kind, b.entity_id, u);
    if (u.role === "engineer" && rec.assignee_id && rec.assignee_id !== u.id)
      throw new AppError(403, "담당 작업에만 기록할 수 있습니다.");
    const db = await getDb(),
      id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO entries(id,entity_kind,entity_id,user_id,body,evidence_level) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, b.entity_kind, b.entity_id, u.id, b.body.trim(), b.evidence_level],
      );
      await audit(tx, u.id, "comment", b.entity_kind, b.entity_id);
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
