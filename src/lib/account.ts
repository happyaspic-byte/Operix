import { getDb } from "./db";
import { AppError } from "./policy";
import { verifyPassword, hashPassword, audit, type User } from "./auth";
import { lockBusiness } from "./transactions";
export async function changePassword(
  user: User,
  current: string,
  password: string,
) {
  if (password.length < 12 || password.length > 256 || password === current)
    throw new AppError(400, "현재와 다른 12~256자 비밀번호를 입력해 주세요.");
  const db = await getDb();
  // Hash outside transaction, then compare the current hash under the write lock.
  const [before] = await db.query(
    "SELECT password_hash FROM users WHERE id=$1",
    [user.id],
  );
  if (!before || !(await verifyPassword(current, before.password_hash)))
    throw new AppError(400, "현재 비밀번호가 일치하지 않습니다.");
  const hash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await lockBusiness(tx);
    const changed = await tx.query(
      "UPDATE users SET password_hash=$2,must_change_password=false,version=version+1,updated_at=now() WHERE id=$1 AND password_hash=$3 AND active=true RETURNING id",
      [user.id, hash, before.password_hash],
    );
    if (!changed.length)
      throw new AppError(409, "계정이 변경되었습니다. 다시 로그인해 주세요.");
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
    await audit(tx, user.id, "change_password", "users", user.id);
  });
}
export async function handoff(user: User, from: string, to: string) {
  if (user.role !== "admin")
    throw new AppError(403, "관리자 권한이 필요합니다.");
  if (from === to) throw new AppError(400, "서로 다른 담당자를 선택해 주세요.");
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    const [target] = await tx.query(
      "SELECT id,role FROM users WHERE id=$1 AND active=true",
      [to],
    );
    if (!target || !["admin", "manager", "engineer"].includes(target.role))
      throw new AppError(
        400,
        "활성 기술지원 또는 관리자를 인계 담당자로 선택해 주세요.",
      );
    const counts: Record<string, number> = {};
    for (const [table, column, filter] of [
      ["assets", "owner_id", "status<>'archived'"],
      ["contracts", "owner_id", "status='active'"],
      ["maintenance_plans", "assignee_id", "status='active'"],
      [
        "inspections",
        "assignee_id",
        "deleted_at IS NULL AND status IN ('scheduled','in_progress')",
      ],
      ["tickets", "assignee_id", "status NOT IN ('resolved','closed')"],
    ]) {
      const rows = await tx.query(
        `UPDATE ${table} SET ${column}=$2,version=version+1,updated_at=now() WHERE ${column}=$1 AND ${filter} RETURNING id`,
        [from, to],
      );
      counts[table] = rows.length;
      for (const row of rows)
        await audit(tx, user.id, "handoff", table, row.id, {
          from_user: from,
          to_user: to,
        });
      await tx.query(
        "DELETE FROM notifications WHERE source_kind=$1 AND source_id=ANY($2::text[])",
        [table, rows.map((r) => r.id)],
      );
    }
    return counts;
  });
}
