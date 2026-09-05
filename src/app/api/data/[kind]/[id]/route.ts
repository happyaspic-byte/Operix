import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { getRecord, saveRecord } from "@/lib/records";
import { securityLog } from "@/lib/security";
import { failure, readJson } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const user = await requireUser(),
      p = await params;
    const row = await getRecord(p.kind, p.id, user);
    await securityLog(
      user,
      { action: "read", kind: p.kind, ids: [p.id] },
      request,
    );
    return NextResponse.json(row);
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    assertOrigin(request);
    const user = await requireUser(),
      p = await params;
    return NextResponse.json(
      await saveRecord(p.kind, user, await readJson(request), p.id),
    );
  } catch (e) {
    return failure(e);
  }
}
