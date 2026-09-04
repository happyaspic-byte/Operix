import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { details } from "@/lib/details";
import { failure } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const u = await requireUser(),
      p = await params;
    return NextResponse.json(await details(p.kind, p.id, u));
  } catch (e) {
    return failure(e);
  }
}
