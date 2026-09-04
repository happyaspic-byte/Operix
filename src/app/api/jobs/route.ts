import { NextResponse } from "next/server";
import { requireUser, assertOrigin } from "@/lib/auth";
import { requirePermission } from "@/lib/policy";
import { runJobs } from "@/lib/jobs";
import { failure } from "@/lib/http";
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "users:write");
    return NextResponse.json(await runJobs());
  } catch (e) {
    return failure(e);
  }
}
