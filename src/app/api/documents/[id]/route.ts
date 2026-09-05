import { NextResponse } from "next/server";
import { z } from "zod";
import { assertOrigin, requireUser, audit, type User } from "@/lib/auth";
import { failure, readJson, parseInput } from "@/lib/http";
import { downloadDocument, createDownloadGrant } from "@/lib/documents";
import { validateClassification } from "@/lib/document-policy";
import { securityLog } from "@/lib/security";
import { AppError, requirePermission } from "@/lib/policy";
import { getDb } from "@/lib/db";
import { lockBusiness } from "@/lib/transactions";
type Context = { params: Promise<{ id: string }> };
async function denied(
  u: User | undefined,
  id: string,
  e: unknown,
  request: Request,
) {
  if (u && e instanceof AppError && e.status === 403)
    await securityLog(
      u,
      {
        action: "document_access",
        kind: "documents",
        ids: [id],
        outcome: "denied",
      },
      request,
    );
  return failure(e);
}
export async function GET(request: Request, { params }: Context) {
  let u: User | undefined;
  const { id } = await params;
  try {
    u = await requireUser();
    const { doc, stream } = await downloadDocument(
      u,
      id,
      new URL(request.url).searchParams,
      request,
    );
    return new NextResponse(stream, {
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Length": String(doc.size_bytes),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return denied(u, id, e, request);
  }
}
export async function POST(request: Request, { params }: Context) {
  let u: User | undefined;
  const { id } = await params;
  try {
    assertOrigin(request);
    u = await requireUser();
    const b = parseInput(
      z.object({ reason: z.string().trim().min(5).max(500) }).strict(),
      await readJson(request),
    );
    return NextResponse.json(
      await createDownloadGrant(u, id, b.reason, request),
    );
  } catch (e) {
    return denied(u, id, e, request);
  }
}
export async function PATCH(request: Request, { params }: Context) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    requirePermission(u.role, "reports:approve");
    const { id } = await params,
      b = parseInput(
        z
          .object({
            classification: z.string(),
            version: z.number().int().positive(),
            rescan: z.boolean().default(false),
          })
          .strict(),
        await readJson(request),
      );
    const classification = validateClassification(u.role, b.classification),
      db = await getDb();
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      const rows = await tx.query(
        "UPDATE documents SET classification=$2,version=version+1,scan_status=CASE WHEN $4 THEN 'pending' ELSE scan_status END WHERE id=$1 AND version=$3 AND deleted_at IS NULL RETURNING id",
        [id, classification, b.version, b.rescan],
      );
      if (!rows.length)
        throw new AppError(
          409,
          "자료가 변경되었습니다. 새로고침 후 다시 시도해 주세요.",
        );
      await tx.query("DELETE FROM download_grants WHERE document_id=$1", [id]);
      await audit(tx, u.id, "classify", "documents", id, { classification });
    });
    await securityLog(
      u,
      { action: "classify", kind: "documents", ids: [id] },
      request,
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    return failure(e);
  }
}
