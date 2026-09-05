import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, assertOrigin } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { getDb } from "@/lib/db";
import { requirePermission, AppError } from "@/lib/policy";
import {
  failure,
  readJson,
  readMultipart,
  parseInput,
  withUploadSlot,
} from "@/lib/http";
import { workbookBytes } from "@/lib/sheets";
import {
  importKinds,
  importMapping,
  previewImport,
  commitImport,
} from "@/lib/imports";
import { securityLog } from "@/lib/security";
export async function GET(request: Request) {
  try {
    const u = await requireUser(),
      kind = parseInput(
        z.enum(importKinds),
        new URL(request.url).searchParams.get("kind") || "assets",
      );
    requirePermission(u.role, catalog[kind].permission);
    const [site] = await (
        await getDb()
      ).query(
        "SELECT s.id,s.name,c.name customer_name FROM sites s JOIN customers c ON c.id=s.customer_id WHERE s.status='active' AND c.status='active' LIMIT 1",
      ),
      data =
        kind === "assets"
          ? {
              site_id: site?.id || "",
              name: "예시 서버",
              product: "Server",
              asset_tag: "SAMPLE-001",
              status: "unknown",
              protection: "unknown",
            }
          : kind === "customers"
            ? { name: "예시 고객사", status: "active" }
            : kind === "sites"
              ? {
                  name: "예시 사업장",
                  customer_name: site?.customer_name || "기존 고객사명",
                  status: "active",
                }
              : {
                  name: "예시 계약",
                  customer_name: site?.customer_name || "기존 고객사명",
                  kind: "maintenance",
                  term: "unknown",
                  notice_days: 90,
                  status: "active",
                  renewal: "not_started",
                };
    return new NextResponse(
      await workbookBytes([data], Object.entries(importMapping(kind))),
      {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename=operix-${kind}-template.xlsx`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    return await withUploadSlot(async () => {
      const form = await readMultipart(request, 6 * 1024 * 1024),
        file = form.get("file"),
        kind = parseInput(z.enum(importKinds), form.get("kind") || "assets");
      if (!(file instanceof File))
        throw new AppError(400, "파일을 선택해 주세요.");
      let mapping;
      try {
        mapping = JSON.parse(String(form.get("mapping") || "{}"));
      } catch {
        throw new AppError(400, "열 연결 형식을 확인해 주세요.");
      }
      return NextResponse.json(await previewImport(u, kind, file, mapping));
    });
  } catch (e) {
    return failure(e);
  }
}
export async function PATCH(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser(),
      b = parseInput(
        z.object({ batch_id: z.string().uuid() }).strict(),
        await readJson(request),
      ),
      r = await commitImport(u, b.batch_id);
    await securityLog(
      u,
      { action: "import_commit", kind: "import_batches", ids: [b.batch_id] },
      request,
    );
    return NextResponse.json(r);
  } catch (e) {
    return failure(e);
  }
}
