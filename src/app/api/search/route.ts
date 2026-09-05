import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { securityLog } from "@/lib/security";
import { failure } from "@/lib/http";
export async function GET(request: Request) {
  try {
    const u = await requireUser();
    const q = new URL(request.url).searchParams.get("q")?.trim().slice(0, 100);
    if (!q) return NextResponse.json([]);
    const rows = await (
      await getDb()
    ).query(
      "SELECT id,name,'customers' kind FROM customers WHERE name ILIKE $1 UNION ALL SELECT id,name,'assets' kind FROM assets WHERE name ILIKE $1 OR asset_tag ILIKE $1 UNION ALL SELECT id,name,'tickets' kind FROM tickets WHERE name ILIKE $1 UNION ALL SELECT id,name,'contracts' kind FROM contracts WHERE name ILIKE $1 LIMIT 12",
      [`%${q}%`],
    );
    await securityLog(
      u,
      { action: "search", kind: "records", ids: rows.map((r) => r.id) },
      request,
    );
    return NextResponse.json(rows);
  } catch (e) {
    return failure(e);
  }
}
