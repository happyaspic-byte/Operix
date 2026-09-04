import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { requireUser, audit } from "@/lib/auth";
import { getRecord } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError } from "@/lib/policy";
import { failure } from "@/lib/http";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const u = await requireUser(),
      db = await getDb();
    const [doc] = await db.query("SELECT * FROM documents WHERE id=$1", [
      (await params).id,
    ]);
    if (!doc) throw new AppError(404, "첨부 자료를 찾을 수 없습니다.");
    await getRecord(doc.entity_kind, doc.entity_id, u);
    const data = await readFile(
      join(
        resolve(process.env.UPLOAD_DIR || "storage/uploads"),
        doc.storage_key,
      ),
    );
    await audit(db, u.id, "download", doc.entity_kind, doc.entity_id, {
      document_id: doc.id,
    });
    return new NextResponse(data, {
      headers: {
        "Content-Type": doc.mime_type,
        "Content-Length": String(data.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    return failure(e);
  }
}
