import { z } from "zod";
import { getDb, type Database, type Row } from "./db";
import { audit, hashPassword, type User } from "./auth";
import { AppError, requirePermission, roles } from "./policy";
import { lockBusiness } from "./transactions";

const columns =
  "id,email,name,role,active,department,job_title,version,created_at,updated_at,deleted_at,deleted_by,privacy_erased_at,must_change_password";
const saveSchema = z
  .object({
    id: z.string().uuid().optional(),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(100),
    role: z.enum(roles),
    active: z.boolean(),
    password: z.string().min(12).max(256).optional(),
    version: z.number().int().positive().optional(),
    department: z.string().trim().max(100).optional(),
    job_title: z.string().trim().max(100).optional(),
  })
  .strict();
const deletionSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    deleted: z.boolean(),
  })
  .strict();

async function requireCurrentAdmin(db: Database, user: User) {
  requirePermission(user.role, "users:write");
  const [actor] = await db.query(
    "SELECT role,active,deleted_at,privacy_erased_at FROM users WHERE id=$1",
    [user.id],
  );
  if (!actor || !actor.active || actor.deleted_at || actor.privacy_erased_at)
    throw new AppError(403, "현재 계정으로 사용자를 관리할 수 없습니다.");
  requirePermission(actor.role, "users:write");
}

async function lockedUser(tx: Database, id: string, version: number) {
  const [row] = await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
    id,
  ]);
  if (!row) throw new AppError(404, "사용자를 찾을 수 없습니다.");
  if (row.privacy_erased_at)
    throw new AppError(410, "파기된 계정은 수정하거나 복구할 수 없습니다.");
  if (row.version !== version)
    throw new AppError(409, "사용자 정보가 변경되었습니다. 새로고침해 주세요.");
  return row;
}

async function preserveAdministrator(tx: Database, previous: Row) {
  if (previous.role !== "admin" || !previous.active || previous.deleted_at)
    return;
  const remaining = await tx.query(
    "SELECT id FROM users WHERE id<>$1 AND role='admin' AND active=true AND deleted_at IS NULL AND privacy_erased_at IS NULL LIMIT 1",
    [previous.id],
  );
  if (!remaining.length)
    throw new AppError(409, "활성 시스템 관리자는 최소 한 명 있어야 합니다.");
}

export async function listUsers(user: User, trash = false) {
  const db = await getDb();
  await requireCurrentAdmin(db, user);
  return db.query(
    `SELECT ${columns} FROM users WHERE deleted_at IS ${trash ? "NOT " : ""}NULL ORDER BY created_at,id`,
  );
}

export async function saveUser(user: User, input: unknown) {
  requirePermission(user.role, "users:write");
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(
      400,
      "이름·이메일·역할을 확인해 주세요. 부서·직책은 100자 이내, 비밀번호는 12~256자여야 합니다.",
    );
  const data = parsed.data;
  if (data.id && data.version === undefined)
    throw new AppError(400, "수정 버전이 필요합니다.");
  if (!data.id && !data.password)
    throw new AppError(400, "신규 계정의 초기 비밀번호가 필요합니다.");
  const hash = data.password ? await hashPassword(data.password) : null;
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    // Authorization obtained before this lock may have been revoked meanwhile.
    await requireCurrentAdmin(tx, user);
    const previous = data.id
      ? await lockedUser(tx, data.id, data.version!)
      : undefined;
    if (previous?.deleted_at)
      throw new AppError(410, "삭제된 계정은 복원한 뒤 수정해 주세요.");
    if (data.id === user.id && (!data.active || data.role !== "admin"))
      throw new AppError(
        400,
        "현재 관리자는 자신의 역할·활성 상태를 변경할 수 없습니다.",
      );
    if (previous && (!data.active || data.role !== "admin"))
      await preserveAdministrator(tx, previous);
    const id = data.id || crypto.randomUUID();
    const duplicate = await tx.query(
      "SELECT id FROM users WHERE email=$1 AND id<>$2",
      [data.email, id],
    );
    if (duplicate.length)
      throw new AppError(
        409,
        "이미 등록된 이메일입니다. 삭제된 계정이면 휴지통에서 복원해 주세요.",
      );
    const department = data.department ?? previous?.department ?? "";
    const jobTitle = data.job_title ?? previous?.job_title ?? "";
    let row: Row;
    if (previous) {
      [row] = await tx.query(
        `UPDATE users SET email=$2,name=$3,role=$4,active=$5,password_hash=coalesce($6,password_hash),must_change_password=CASE WHEN $6::text IS NOT NULL THEN true ELSE must_change_password END,department=$7,job_title=$8,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
        [
          id,
          data.email,
          data.name,
          data.role,
          data.active,
          hash,
          department,
          jobTitle,
        ],
      );
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    } else {
      [row] = await tx.query(
        `INSERT INTO users(id,email,name,role,active,password_hash,must_change_password,department,job_title) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING ${columns}`,
        [
          id,
          data.email,
          data.name,
          data.role,
          data.active,
          hash,
          department,
          jobTitle,
        ],
      );
    }
    await audit(
      tx,
      user.id,
      previous ? "update_user" : "invite_user",
      "users",
      id,
      {
        role: data.role,
        active: data.active,
        password_changed: !!hash,
        version_before: previous?.version ?? null,
        version_after: row.version,
      },
    );
    return row;
  });
}

export async function setUserDeleted(user: User, input: unknown) {
  requirePermission(user.role, "users:write");
  const parsed = deletionSchema.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, "대상 계정과 수정 버전을 확인해 주세요.");
  const data = parsed.data;
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockBusiness(tx);
    await requireCurrentAdmin(tx, user);
    const previous = await lockedUser(tx, data.id, data.version);
    if (data.deleted && data.id === user.id)
      throw new AppError(400, "현재 로그인한 계정은 삭제할 수 없습니다.");
    if (!!previous.deleted_at === data.deleted)
      throw new AppError(
        409,
        data.deleted ? "이미 삭제된 계정입니다." : "삭제되지 않은 계정입니다.",
      );
    if (data.deleted) await preserveAdministrator(tx, previous);
    const [row] = await tx.query(
      `UPDATE users SET active=false,deleted_at=CASE WHEN $2 THEN now() ELSE NULL END,deleted_by=CASE WHEN $2 THEN $3 ELSE NULL END,version=version+1,updated_at=now() WHERE id=$1 RETURNING ${columns}`,
      [data.id, data.deleted, user.id],
    );
    // Restoration must not revive a cookie or a previously issued download grant.
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [data.id]);
    await tx.query("DELETE FROM download_grants WHERE user_id=$1", [data.id]);
    await audit(
      tx,
      user.id,
      data.deleted ? "delete_user" : "restore_user",
      "users",
      data.id,
      { version_before: previous.version, version_after: row.version },
    );
    return row;
  });
}
