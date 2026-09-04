import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { sealData, unsealData } from "iron-session";
import { cookies } from "next/headers";
import { getDb, type Database } from "./db";
import { AppError, type Role } from "./policy";
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
};
export const COOKIE = "operix_session";
const TTL = 8 * 60 * 60;
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  return s;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function scrypt(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (e, key) => (e ? reject(e) : resolve(key)),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await scrypt(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [algorithm, salt, value] = hash.split(":");
  if (algorithm !== "scrypt" || !salt || !value) return false;
  const stored = Buffer.from(value, "hex");
  const result = await scrypt(password, salt);
  return stored.length === result.length && timingSafeEqual(stored, result);
}
export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const db = await getDb();
  await db.query(
    "INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,$3)",
    [digest(token), userId, new Date(Date.now() + TTL * 1000)],
  );
  return sealData({ token }, { password: secret(), ttl: TTL });
}
export async function resolveSession(
  cookie: string | undefined,
): Promise<User | null> {
  if (!cookie) return null;
  try {
    const data = await unsealData<{ token?: string }>(cookie, {
      password: secret(),
      ttl: TTL,
    });
    if (!data.token) return null;
    const [user] = await (
      await getDb()
    ).query(
      "SELECT u.id,u.email,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now() AND u.active=true",
      [digest(data.token)],
    );
    return (user as User) || null;
  } catch {
    return null;
  }
}
export async function currentUser() {
  return resolveSession((await cookies()).get(COOKIE)?.value);
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new AppError(401, "로그인이 필요합니다.");
  return user;
}
export async function revokeSession(cookie: string | undefined) {
  if (!cookie) return;
  const data = await unsealData<{ token?: string }>(cookie, {
    password: secret(),
    ttl: TTL,
  });
  if (data.token)
    await (
      await getDb()
    ).query("DELETE FROM sessions WHERE id=$1", [digest(data.token)]);
}
export function cookieOptions() {
  return {
    httpOnly: true,
    secure: (process.env.APP_URL || "").startsWith("https://"),
    sameSite: "lax" as const,
    path: "/",
    maxAge: TTL,
  };
}
export function assertOrigin(request: Request) {
  const expected = process.env.APP_URL;
  if (!expected) throw new Error("APP_URL is required");
  if (request.headers.get("origin") !== new URL(expected).origin)
    throw new AppError(403, "허용되지 않은 요청 출처입니다.");
}
export async function attemptLogin(email: string, password: string) {
  const db = await getDb();
  const key = digest(email.toLowerCase());
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO login_attempts(id) VALUES ($1) ON CONFLICT DO NOTHING",
      [key],
    );
    const [rate] = await tx.query(
      "SELECT * FROM login_attempts WHERE id=$1 FOR UPDATE",
      [key],
    );
    const recent =
      Date.now() - new Date(rate.window_start).getTime() < 15 * 60 * 1000;
    if (recent && rate.attempts >= 5)
      throw new AppError(
        429,
        "로그인 시도가 많습니다. 15분 후 다시 시도해 주세요.",
      );
    await tx.query(
      "UPDATE login_attempts SET attempts=$2,window_start=$3 WHERE id=$1",
      [
        key,
        recent ? rate.attempts + 1 : 1,
        recent ? rate.window_start : new Date(),
      ],
    );
  });
  const [user] = await db.query("SELECT * FROM users WHERE email=$1", [
    email.toLowerCase(),
  ]);
  const dummy = "scrypt:00000000000000000000000000000000:" + "0".repeat(128);
  const ok = await verifyPassword(password, user?.password_hash || dummy);
  if (!user || !user.active || !ok)
    throw new AppError(401, "이메일 또는 비밀번호가 올바르지 않습니다.");
  await db.query("DELETE FROM login_attempts WHERE id=$1", [key]);
  return user as User;
}
export async function audit(
  db: Database,
  userId: string | null,
  action: string,
  kind: string,
  id: string,
  details: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_kind,entity_id,details) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), userId, action, kind, id, JSON.stringify(details)],
  );
}
