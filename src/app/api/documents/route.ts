import { NextResponse } from "next/server";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { assertOrigin, requireUser, audit } from "@/lib/auth";
import { catalog } from "@/lib/catalog";
import { getRecord } from "@/lib/records";
import { getDb } from "@/lib/db";
import { AppError, requirePermission } from "@/lib/policy";
import { failure } from "@/lib/http";
export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(
      await (
        await getDb()
      ).query(
        "SELECT id,entity_kind,entity_id,name,mime_type,size_bytes,created_at FROM documents ORDER BY created_at DESC LIMIT 100",
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    assertOrigin(request);
    const u = await requireUser();
    if (Number(request.headers.get("content-length")) > 21 * 1024 * 1024)
      throw new AppError(413, "파일은 20MB 이하로 업로드해 주세요.");
    const form = await request.formData();
    const kind = String(form.get("entity_kind")),
      entityId = String(form.get("entity_id"));
    if (!catalog[kind]) throw new AppError(400, "자료 대상을 확인해 주세요.");
    requirePermission(u.role, catalog[kind].permission);
    const rec = await getRecord(kind, entityId, u);
    if (
      u.role === "engineer" &&
      ["inspections", "tickets"].includes(kind) &&
      rec.assignee_id &&
      rec.assignee_id !== u.id
    )
      throw new AppError(403, "담당 업무에만 첨부할 수 있습니다.");
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      file.size === 0 ||
      file.size > 20 * 1024 * 1024
    )
      throw new AppError(400, "1바이트~20MB 파일을 선택해 주세요.");
    const data = Buffer.from(await file.arrayBuffer()),
      ext = file.name.split(".").pop()?.toLowerCase();
    let mime = "";
    if (
      ext === "png" &&
      data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    if (
      ["jpg", "jpeg"].includes(ext || "") &&
      data[0] === 255 &&
      data[1] === 216 &&
      data[2] === 255
    )
      mime = "image/jpeg";
    if (ext === "pdf" && data.subarray(0, 5).toString() === "%PDF-")
      mime = "application/pdf";
    if (
      ["zip", "docx", "xlsx"].includes(ext || "") &&
      data[0] === 80 &&
      data[1] === 75
    )
      mime =
        ext === "zip"
          ? "application/zip"
          : ext === "docx"
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (["txt", "csv", "log"].includes(ext || "") && !data.includes(0))
      mime = "text/plain";
    if (!mime)
      throw new AppError(
        400,
        "허용된 형식은 PNG, JPG, PDF, TXT, CSV, LOG, ZIP, DOCX, XLSX입니다. 파일 내용을 확인해 주세요.",
      );
    const id = crypto.randomUUID(),
      root = resolve(process.env.UPLOAD_DIR || "storage/uploads"),
      path = join(root, id);
    await mkdir(root, { recursive: true });
    await writeFile(path, data, { flag: "wx" });
    try {
      const db = await getDb();
      await db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            id,
            kind,
            entityId,
            file.name.replace(/[\r\n\x00-\x1f]/g, "").slice(0, 150),
            mime,
            file.size,
            id,
            u.id,
          ],
        );
        await audit(tx, u.id, "upload", kind, entityId, { document_id: id });
      });
    } catch (e) {
      await unlink(path);
      throw e;
    }
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return failure(e);
  }
}
