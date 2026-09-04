import { NextResponse } from "next/server";
import {
  assertOrigin,
  attemptLogin,
  createSession,
  COOKIE,
  cookieOptions,
  audit,
} from "@/lib/auth";
import { failure, readJson } from "@/lib/http";
import { AppError } from "@/lib/policy";
import { getDb } from "@/lib/db";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const b = await readJson(request);
    if (
      typeof b.email !== "string" ||
      typeof b.password !== "string" ||
      b.email.length > 254 ||
      b.password.length > 256
    )
      throw new AppError(400, "이메일과 비밀번호를 확인해 주세요.");
    const user = await attemptLogin(b.email.trim(), b.password);
    const session = await createSession(user.id);
    await audit(await getDb(), user.id, "login", "users", user.id);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE, session, cookieOptions());
    return res;
  } catch (e) {
    return failure(e);
  }
}
