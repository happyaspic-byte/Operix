import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { details } from "@/lib/details";
import { securityLog } from "@/lib/security";
import { failure } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const u = await requireUser(),
      p = await params;
    const result = await details(
      p.kind,
      p.id,
      u,
      new URL(request.url).searchParams,
    );
    await securityLog(
      u,
      { action: "read_detail", kind: p.kind, ids: [p.id] },
      request,
    );
    return NextResponse.json(result);
  } catch (e) {
    return failure(e);
  }
}
