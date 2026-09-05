import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, assertOrigin, audit } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { requirePermission, AppError } from "@/lib/policy";
import { readJson, parseInput, failure } from "@/lib/http";
import { createFollowUp } from "@/lib/workflow";
import { lockBusiness } from "@/lib/transactions";
import { securityLog } from "@/lib/security";
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("follow_up"),
      inspection_id: z.string().uuid(),
      title: z.string().trim().min(1).max(300),
    })
    .strict(),
  z
    .object({
      action: z.literal("sla_policy"),
      severity: z.enum(["critical", "high", "medium", "low"]),
      enabled: z.boolean(),
      response_minutes: z.number().int().min(1).max(525600),
      resolution_minutes: z.number().int().min(1).max(525600),
      version: z.number().int().positive(),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const u = await requireUser(),
      q = new URL(request.url).searchParams,
      db = await getDb();
    if (q.get("entity_id")) {
      const id = q.get("entity_id")!,
        history = await db.query(
          "SELECT h.*,u.name user_name FROM work_status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.entity_id=$1 ORDER BY h.created_at DESC LIMIT 100",
          [id],
        );
      await securityLog(
        u,
        { action: "read_work_status", kind: "work_status_history", ids: [id] },
        request,
      );
      return NextResponse.json(history);
    }
    requirePermission(u.role, "users:write");
    return NextResponse.json(
      await db.query("SELECT * FROM sla_policies ORDER BY severity"),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser(),
      b = parseInput(schema, await readJson(request));
    if (b.action === "follow_up")
      return NextResponse.json(
        await createFollowUp(u, b.inspection_id, b.title),
      );
    requirePermission(u.role, "users:write");
    if (b.response_minutes > b.resolution_minutes)
      throw new AppError(400, "해결 목표는 응답 목표보다 길어야 합니다.");
    await (
      await getDb()
    ).transaction(async (tx) => {
      await lockBusiness(tx);
      const rows = await tx.query(
        "UPDATE sla_policies SET enabled=$2,response_minutes=$3,resolution_minutes=$4,version=version+1,updated_by=$5,updated_at=now() WHERE severity=$1 AND version=$6 RETURNING severity",
        [
          b.severity,
          b.enabled,
          b.response_minutes,
          b.resolution_minutes,
          u.id,
          b.version,
        ],
      );
      if (!rows.length)
        throw new AppError(409, "정책이 변경되었습니다. 다시 확인해 주세요.");
      await audit(tx, u.id, "sla_policy", "sla_policies", b.severity, {
        enabled: b.enabled,
        response_minutes: b.response_minutes,
        resolution_minutes: b.resolution_minutes,
      });
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
