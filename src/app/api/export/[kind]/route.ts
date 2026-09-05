import { NextResponse } from "next/server";
import { requireUser, audit } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { listRecords } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError, requirePermission, can } from "@/lib/policy";
import { securityLog } from "@/lib/security";
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
    const query = new URL(request.url).searchParams;
    const rows = await db.transaction(async (tx) => {
      await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const output: Record<string, any>[] = [];
      const params = new URLSearchParams(query);
      params.set("limit", "100");
      params.set("page", "1");
      let result = await listRecords(kind, u, params, tx);
      if (result.total > 10000)
        throw new AppError(
          400,
          "검색 조건으로 10,000건 이하로 줄인 뒤 내보내 주세요.",
        );
      output.push(...result.rows);
      for (let page = 2; output.length < result.total; page++) {
        params.set("page", String(page));
        result = await listRecords(kind, u, params, tx);
        output.push(...result.rows);
      }
      return output;
    });
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
    await audit(db, u.id, "export", kind, "filtered", { count: rows.length });
    for (let n = 0; n < Math.max(rows.length, 1); n += 100)
      await securityLog(
        u,
        {
          action: "export",
          kind,
          ids: rows.slice(n, n + 100).map((r) => r.id),
          reason: "사용자가 선택한 목록 조건 내보내기",
        },
        request,
      );
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
