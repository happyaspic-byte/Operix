import { z } from "zod";
import { lockBusiness } from "@/lib/transactions";
import { securityLog } from "@/lib/security";
import { NextResponse } from "next/server";
import { assertOrigin, requireUser, audit } from "@/lib/auth";
import { getRecord } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError, requirePermission } from "@/lib/policy";
import { failure, readJson, parseInput } from "@/lib/http";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "work:write");
    const b = parseInput(
      z
        .object({
          entity_kind: z.enum(["inspections", "tickets"]),
          entity_id: z.string().uuid(),
          body: z.string().trim().min(1).max(10000),
          evidence_level: z.enum(["observed", "internal", "vendor"]),
          customer_visible: z.boolean().default(false),
        })
        .strict(),
      await readJson(request),
    );
    if (
      !["inspections", "tickets"].includes(b.entity_kind) ||
      typeof b.body !== "string" ||
      !b.body.trim() ||
      b.body.length > 10000 ||
      !["observed", "internal", "vendor"].includes(b.evidence_level)
    )
      throw new AppError(400, "기록 내용과 근거 구분을 확인해 주세요.");
    const db = await getDb(),
      id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const rec = await getRecord(b.entity_kind, b.entity_id, u, tx);
      if (u.role === "engineer" && rec.assignee_id && rec.assignee_id !== u.id)
        throw new AppError(403, "담당 작업에만 기록할 수 있습니다.");
      await tx.query(
        "INSERT INTO entries(id,entity_kind,entity_id,user_id,body,evidence_level,customer_visible) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          b.entity_kind,
          b.entity_id,
          u.id,
          b.body.trim(),
          b.evidence_level,
          b.customer_visible && b.evidence_level !== "internal",
        ],
      );
      if (b.entity_kind === "tickets")
        await tx.query(
          "UPDATE tickets SET first_response_at=coalesce(first_response_at,now()) WHERE id=$1",
          [b.entity_id],
        );
      await audit(tx, u.id, "comment", b.entity_kind, b.entity_id);
    });
    await securityLog(
      u,
      { action: "create_entry", kind: b.entity_kind, ids: [b.entity_id] },
      request,
    );
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
