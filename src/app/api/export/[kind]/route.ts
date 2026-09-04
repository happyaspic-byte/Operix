import { NextResponse } from "next/server";
import { requireUser, audit } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { selection } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError, requirePermission, can, redact } from "@/lib/policy";
import { failure } from "@/lib/http";
import { safeCsv, workbookBytes } from "@/lib/sheets";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
) {
  try {
    const u = await requireUser();
    requirePermission(u.role, "export");
    const kind = (await params).kind,
      config = catalog[kind];
    if (!config) throw new AppError(404, "자료 유형을 찾을 수 없습니다.");
    const db = await getDb();
    const [count] = await db.query(`SELECT count(*)::int total FROM ${kind}`);
    if (count.total > 10000)
      throw new AppError(
        400,
        "한 번에 10,000건까지 내보낼 수 있습니다. 대용량 내보내기는 관리자에게 요청해 주세요.",
      );
    const rows = (
      await db.query(selection(kind) + " ORDER BY e.created_at LIMIT 10000")
    ).map((r) => redact(r, u.role));
    const columns: [string, string][] = [
      ["id", "내부 ID"],
      ...config.fields
        .filter(
          (f) =>
            !["assets", "checklist"].includes(f.type || "") &&
            (!f.permission || can(u.role, f.permission)),
        )
        .map((f) => [f.key, f.label] as [string, string]),
    ];
    const csv = new URL(request.url).searchParams.get("format") === "csv";
    const bytes = csv
      ? Buffer.from(
          "\uFEFF" +
            [
              columns.map((c) => safeCsv(c[1])).join(","),
              ...rows.map((r) =>
                columns.map((c) => safeCsv(r[c[0]])).join(","),
              ),
            ].join("\r\n"),
        )
      : await workbookBytes(rows, columns);
    await audit(db, u.id, "export", kind, "all", { count: rows.length });
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": csv
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="operix-${kind}.${csv ? "csv" : "xlsx"}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
