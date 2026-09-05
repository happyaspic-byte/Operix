import { NextResponse } from "next/server";
import { z } from "zod";
import {
  requireUser,
  assertOrigin,
  createSession,
  COOKIE,
  cookieOptions,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { readJson, parseInput, failure } from "@/lib/http";
import { changePassword, handoff } from "@/lib/account";
import { securityLog } from "@/lib/security";
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("password"),
      current_password: z.string().min(1).max(256),
      password: z.string().min(12).max(256),
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke"),
      session_id: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("handoff"),
      from: z.string().uuid(),
      to: z.string().uuid(),
    })
    .strict(),
]);
export async function GET() {
  try {
    const u = await requireUser(true),
      sessions = await (
        await getDb()
      ).query(
        "SELECT id,created_at,last_seen_at,expires_at,client_address,user_agent FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY last_seen_at DESC",
        [u.id],
      );
    return NextResponse.json({ user: u, sessions });
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser(true),
      b = parseInput(schema, await readJson(request));
    let result: unknown = { ok: true };
    const response = NextResponse.json(result);
    if (b.action === "password") {
      await changePassword(u, b.current_password, b.password);
      response.cookies.set(
        COOKIE,
        await createSession(u.id, request),
        cookieOptions(),
      );
    } else if (b.action === "revoke")
      await (
        await getDb()
      ).query("DELETE FROM sessions WHERE id=$1 AND user_id=$2", [
        b.session_id,
        u.id,
      ]);
    else {
      await requireUser();
      result = await handoff(u, b.from, b.to);
    }
    await securityLog(
      u,
      { action: "account_" + b.action, kind: "users", ids: [u.id] },
      request,
    );
    return b.action === "handoff" ? NextResponse.json(result) : response;
  } catch (e) {
    return failure(e);
  }
}
