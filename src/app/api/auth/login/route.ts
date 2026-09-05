import { z } from "zod";
import { securityLog } from "@/lib/security";
import { NextResponse } from "next/server";
import {
  assertOrigin,
  attemptLogin,
  createSession,
  COOKIE,
  cookieOptions,
  audit,
} from "@/lib/auth";
import { failure, readJson, parseInput } from "@/lib/http";
import { AppError } from "@/lib/policy";
import { getDb } from "@/lib/db";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const b = parseInput(
      z
        .object({
          email: z.email().max(254),
          password: z.string().min(1).max(256),
        })
        .strict(),
      await readJson(request),
    );
    if (
      typeof b.email !== "string" ||
      typeof b.password !== "string" ||
      b.email.length > 254 ||
      b.password.length > 256
    )
      throw new AppError(400, "이메일과 비밀번호를 확인해 주세요.");
    const user = await attemptLogin(b.email.trim(), b.password, request);
    const session = await createSession(user.id, request);
    await audit(await getDb(), user.id, "login", "users", user.id);
    const res = NextResponse.json({
      ok: true,
      must_change_password: !!user.must_change_password,
    });
    res.cookies.set(COOKIE, session, cookieOptions());
    await securityLog(
      user,
      { action: "login", kind: "users", ids: [user.id] },
      request,
    );
    return res;
  } catch (e) {
    if (e instanceof AppError && [401, 429].includes(e.status))
      await securityLog(
        null,
        { action: "login", kind: "users", outcome: "denied" },
        request,
      );
    return failure(e);
  }
}
