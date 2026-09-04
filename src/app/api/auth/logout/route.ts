import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { assertOrigin, revokeSession, COOKIE, cookieOptions } from "@/lib/auth";
import { failure } from "@/lib/http";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    await revokeSession((await cookies()).get(COOKIE)?.value);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return res;
  } catch (e) {
    return failure(e);
  }
}
