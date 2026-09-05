import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { listRecords, saveRecord } from "@/lib/records";
import { securityLog } from "@/lib/security";
import { failure, readJson } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  try {
    const user = await requireUser();
    const kind = (await params).kind,
      result = await listRecords(kind, user, new URL(request.url).searchParams);
    await securityLog(
      user,
      { action: "list", kind, ids: result.rows.map((r) => r.id) },
      request,
    );
    return NextResponse.json(result);
  } catch (e) {
    return failure(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  try {
    assertOrigin(request);
    const user = await requireUser();
    return NextResponse.json(
      await saveRecord((await params).kind, user, await readJson(request)),
      { status: 201 },
    );
  } catch (e) {
    return failure(e);
  }
}
