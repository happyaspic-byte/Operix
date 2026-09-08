import { NextResponse } from "next/server";
import { z } from "zod";
import { assertOrigin, requireUser, type User } from "@/lib/auth";
import { failure, readJson, parseInput } from "@/lib/http";
import {
  downloadDocument,
  createDownloadGrant,
  classifyDocument,
} from "@/lib/documents";
import { securityLog } from "@/lib/security";
import { AppError, requirePermission } from "@/lib/policy";
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
    const result = await classifyDocument(u, id, b);
    await securityLog(
      u,
      { action: "classify", kind: "documents", ids: [id] },
      request,
    );
    return NextResponse.json(result);
  } catch (e) {
    return failure(e);
  }
}
