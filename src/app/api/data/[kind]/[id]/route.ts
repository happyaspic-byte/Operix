import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { getRecord, saveRecord } from "@/lib/records";
import { failure, readJson } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const user = await requireUser(),
      p = await params;
    return NextResponse.json(await getRecord(p.kind, p.id, user));
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
