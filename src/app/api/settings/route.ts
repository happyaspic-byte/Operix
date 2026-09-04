import { NextResponse } from "next/server";
import { assertOrigin, requireUser, hashPassword, audit } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { AppError, requirePermission, roles } from "@/lib/policy";
import { failure, readJson } from "@/lib/http";
import { z } from "zod";
export async function GET() {
  try {
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    const db = await getDb();
    const [users, jobs, history] = await Promise.all([
      db.query(
        "SELECT id,email,name,role,active,version,created_at FROM users ORDER BY created_at",
      ),
      db.query("SELECT * FROM job_runs"),
      db.query(
        "SELECT a.id,a.action,a.entity_kind,a.created_at,u.name user_name FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 50",
      ),
    ]);
    return NextResponse.json({ users, jobs, history });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    const b = await readJson(request);
    const schema = z
      .object({
        id: z.string().uuid().optional(),
        email: z.email().max(254),
        name: z.string().trim().min(1).max(100),
        role: z.enum(roles),
        active: z.boolean(),
        password: z.string().min(12).max(256).optional(),
        version: z.number().int().positive().optional(),
      })
      .strict();
    const parsed = schema.safeParse(b);
    if (!parsed.success)
      throw new AppError(
        400,
        "이름·이메일·역할을 확인해 주세요. 비밀번호는 12자 이상이어야 합니다.",
      );
    const d = parsed.data;
    if (!d.id && !d.password)
      throw new AppError(400, "신규 계정의 초기 비밀번호가 필요합니다.");
    if (d.id === u.id && (!d.active || d.role !== "admin"))
      throw new AppError(
        400,
        "현재 관리자는 자신의 역할·활성 상태를 변경할 수 없습니다.",
      );
    const hash = d.password ? await hashPassword(d.password) : null,
      db = await getDb();
    const id = d.id || crypto.randomUUID();
    await db.transaction(async (tx) => {
      if (d.id) {
        const [old] = await tx.query(
          "SELECT * FROM users WHERE id=$1 FOR UPDATE",
          [d.id],
        );
        if (!old) throw new AppError(404, "사용자를 찾을 수 없습니다.");
        if (old.version !== d.version)
          throw new AppError(
            409,
            "사용자 정보가 변경되었습니다. 새로고침해 주세요.",
          );
        await tx.query(
          "UPDATE users SET email=$2,name=$3,role=$4,active=$5,password_hash=coalesce($6,password_hash),version=version+1,updated_at=now() WHERE id=$1",
          [id, d.email.toLowerCase(), d.name, d.role, d.active, hash],
        );
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      } else
        await tx.query(
          "INSERT INTO users(id,email,name,role,active,password_hash) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, d.email.toLowerCase(), d.name, d.role, d.active, hash],
        );
      await audit(tx, u.id, d.id ? "update_user" : "invite_user", "users", id, {
        role: d.role,
        active: d.active,
        password_changed: !!hash,
      });
    });
    return NextResponse.json({ id });
  } catch (e) {
    return failure(e);
  }
}
