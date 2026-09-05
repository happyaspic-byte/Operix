import { NextResponse } from "next/server";
import { healthStatus } from "@/lib/operations";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const result = await healthStatus();
    return NextResponse.json(
      { status: result.ok ? "ok" : "degraded" },
      {
        status: result.ok ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
