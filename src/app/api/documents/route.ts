import { NextResponse } from "next/server";
import { assertOrigin, requireUser } from "@/lib/auth";
import { failure, readMultipart, withUploadSlot } from "@/lib/http";
import { listDocuments, uploadDocument } from "@/lib/documents";
import { securityLog } from "@/lib/security";
export async function GET(request: Request) {
  try {
    const u = await requireUser(),
      result = await listDocuments(u, new URL(request.url).searchParams);
    await securityLog(
      u,
      { action: "list", kind: "documents", ids: result.rows.map((r) => r.id) },
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
    const u = await requireUser();
    return await withUploadSlot(async () =>
      NextResponse.json(
        await uploadDocument(u, await readMultipart(request), request),
        { status: 201 },
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
