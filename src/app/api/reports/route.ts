import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { failure, readJson } from "@/lib/http";
import { createReport, listReports } from "@/lib/reports";
import { securityLog } from "@/lib/security";
export async function GET(request: Request) {
  try {
    const u = await requireUser(),
      result = await listReports(u, new URL(request.url).searchParams);
    await securityLog(
      u,
      { action: "list", kind: "reports", ids: result.rows.map((r) => r.id) },
      request,
    );
    return NextResponse.json(result);
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser(),
      r = await createReport(u, await readJson(request));
    await securityLog(
      u,
      { action: "approve_report", kind: "reports", ids: [r.id] },
      request,
    );
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
