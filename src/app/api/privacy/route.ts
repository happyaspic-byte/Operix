import { NextResponse } from "next/server";
import { z } from "zod";
import { assertOrigin, requireUser, audit } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AppError, requirePermission } from "@/lib/policy";
import { readJson, parseInput, failure } from "@/lib/http";
import { previewErasure, executeErasure } from "@/lib/privacy";
import { securityLog } from "@/lib/security";
import { lockBusiness } from "@/lib/transactions";
const subject = z.enum(["customers", "users"]);
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("policy"),
      resource_kind: z.enum([
        "customers",
        "users",
        "documents",
        "reports",
        "business_history",
        "security_logs",
        "backups",
      ]),
      purpose: z.string().trim().min(5).max(500),
      lawful_basis: z.string().trim().min(5).max(500),
      retention_days: z.number().int().min(1).max(36500),
      retention_start: z.string().trim().min(3).max(100),
      exception_rule: z.string().trim().min(3).max(500),
      version: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("hold"),
      subject_kind: subject,
      subject_id: z.string().uuid(),
      reason: z.string().trim().min(5).max(500),
      authority: z.string().trim().min(3).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      id: z.string().uuid(),
      reason: z.string().trim().min(5).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("preview"),
      subject_kind: subject,
      subject_id: z.string().uuid(),
      reason: z.string().trim().min(5).max(500),
      lawful_basis: z.string().trim().min(5).max(500),
    })
    .strict(),
  z
    .object({
      action: z.literal("execute"),
      id: z.string().uuid(),
      confirm: z.literal("파기 실행"),
    })
    .strict(),
  z
    .object({
      action: z.literal("confirm_copies"),
      id: z.string().uuid(),
      disposition: z.string().trim().min(20).max(2000),
      confirm: z.literal("외부 사본 확인 완료"),
    })
    .strict(),
]);
export async function GET(request: Request) {
  try {
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    const db = await getDb(),
      [policies, holds, requests] = await Promise.all([
        db.query("SELECT * FROM privacy_policies ORDER BY resource_kind"),
        db.query(
          "SELECT * FROM privacy_holds ORDER BY created_at DESC LIMIT 100",
        ),
        db.query(
          "SELECT * FROM privacy_requests ORDER BY created_at DESC LIMIT 100",
        ),
      ]);
    await securityLog(
      u,
      { action: "read_privacy", kind: "privacy_requests" },
      request,
    );
    return NextResponse.json({ policies, holds, requests });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    const b = parseInput(schema, await readJson(request)),
      db = await getDb();
    if (b.action === "preview")
      return NextResponse.json(
        await previewErasure(
          u,
          b.subject_kind,
          b.subject_id,
          b.reason,
          b.lawful_basis,
        ),
      );
    if (b.action === "execute")
      return NextResponse.json(await executeErasure(u, b.id));
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      if (b.action === "policy") {
        const rows = await tx.query(
          "UPDATE privacy_policies SET purpose=$2,lawful_basis=$3,retention_days=$4,retention_start=$5,exception_rule=$6,approved_by=$7,approved_at=now(),version=version+1 WHERE resource_kind=$1 AND version=$8 RETURNING resource_kind",
          [
            b.resource_kind,
            b.purpose,
            b.lawful_basis,
            b.retention_days,
            b.retention_start,
            b.exception_rule,
            u.id,
            b.version,
          ],
        );
        if (!rows.length)
          throw new AppError(409, "정책이 변경되었습니다. 새로고침해 주세요.");
      }
      if (b.action === "hold")
        await tx.query(
          "INSERT INTO privacy_holds(id,subject_kind,subject_id,reason,authority,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            crypto.randomUUID(),
            b.subject_kind,
            b.subject_id,
            b.reason,
            b.authority,
            u.id,
          ],
        );
      if (b.action === "release") {
        await tx.query("UPDATE privacy_holds SET active=false WHERE id=$1", [
          b.id,
        ]);
        await audit(tx, u.id, "release_hold", "privacy_holds", b.id, {
          reason: b.reason,
        });
      }
      if (b.action === "confirm_copies") {
        const rows = await tx.query(
          "UPDATE privacy_requests SET state='completed',backup_disposition=$2,backup_confirmed_at=now() WHERE id=$1 AND state='pending_backups' RETURNING id",
          [b.id, b.disposition],
        );
        if (!rows.length)
          throw new AppError(
            409,
            "원본 및 첨부 파기 이후 외부 사본을 확인해 주세요.",
          );
      }
    });
    await securityLog(u, { action: b.action, kind: "privacy" }, request);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
