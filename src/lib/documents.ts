import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, sep } from "node:path";
import { Readable } from "node:stream";
import { getDb, type Row } from "./db";
type DocumentRow = Row & { classification: string; scan_status: string };
import { getRecord } from "./records";
import { catalog } from "./catalog";
import { audit, type User } from "./auth";
import { AppError, requirePermission } from "./policy";
import {
  defaultClassification,
  validateClassification,
  readableClasses,
  requireDocumentAccess,
} from "./document-policy";
import { pagination, queryDate } from "./http";
import { lockBusiness } from "./transactions";
import { scanBytes } from "./file-scanner";
import { securityLog } from "./security";
export const documentRoot = () =>
  resolve(process.env.UPLOAD_DIR || "storage/uploads");
export function documentPath(key: string) {
  if (!/^[a-f0-9-]{36}$/.test(key))
    throw new AppError(400, "저장 경로가 올바르지 않습니다.");
  const path = join(documentRoot(), key);
  if (!path.startsWith(documentRoot() + sep))
    throw new AppError(400, "저장 경로가 올바르지 않습니다.");
  return path;
}
export function fileMime(name: string, data: Buffer) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (
    ext === "png" &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    ["jpg", "jpeg"].includes(ext || "") &&
    data[0] === 255 &&
    data[1] === 216 &&
    data[2] === 255
  )
    return "image/jpeg";
  if (ext === "pdf" && data.subarray(0, 5).toString() === "%PDF-")
    return "application/pdf";
  if (
    ["zip", "docx", "xlsx"].includes(ext || "") &&
    data.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
  )
    return ext === "zip"
      ? "application/zip"
      : ext === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (["txt", "csv", "log"].includes(ext || "") && !data.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      return "text/plain";
    } catch {}
  }
  throw new AppError(400, "허용된 파일 형식과 실제 내용을 확인해 주세요.");
}
export async function listDocuments(user: User, q: URLSearchParams) {
  const db = await getDb(),
    p = pagination(q),
    params: any[] = [readableClasses(user.role)],
    where = ["d.deleted_at IS NULL", "d.classification=ANY($1::text[])"];
  for (const [key, column] of [
    ["entity_kind", "d.entity_kind"],
    ["entity_id", "d.entity_id"],
    ["classification", "d.classification"],
  ] as const)
    if (q.get(key)) {
      params.push(q.get(key));
      where.push(`${column}=$${params.length}`);
    }
  if (q.get("q")) {
    params.push("%" + q.get("q")!.slice(0, 150) + "%");
    where.push(`d.name ILIKE $${params.length}`);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<="],
  ] as const)
    if (q.get(key)) {
      params.push(queryDate(q.get(key)!));
      where.push(`d.created_at::date${op}$${params.length}::date`);
    }
  const filter = where.join(" AND "),
    [count] = await db.query(
      "SELECT count(*)::int total FROM documents d WHERE " + filter,
      params,
    );
  const rows = await db.query(
    `SELECT d.id,d.entity_kind,d.entity_id,d.name,d.mime_type,d.size_bytes,d.created_at,d.classification,d.scan_status,d.version FROM documents d WHERE ${filter} ORDER BY d.created_at DESC,d.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, p.limit, p.offset],
  );
  return { rows, total: count.total, page: p.page, limit: p.limit };
}
export async function uploadDocument(
  user: User,
  form: FormData,
  request?: Request,
) {
  const kind = String(form.get("entity_kind") || ""),
    entityId = String(form.get("entity_id") || ""),
    file = form.get("file");
  if (!Object.hasOwn(catalog, kind) || !/^[-a-f0-9]{36}$/.test(entityId))
    throw new AppError(400, "자료 대상을 확인해 주세요.");
  requirePermission(user.role, catalog[kind].permission);
  const classification = validateClassification(
    user.role,
    form.get("classification") || defaultClassification(kind),
  );
  if (!(file instanceof File) || !file.size || file.size > 20 * 1024 * 1024)
    throw new AppError(400, "1바이트~20MB 파일을 선택해 주세요.");
  const bytes = Buffer.from(await file.arrayBuffer()),
    mime = fileMime(file.name, bytes),
    id = crypto.randomUUID(),
    db = await getDb();
  await mkdir(documentRoot(), { recursive: true, mode: 0o700 });
  const disk = await statfs(documentRoot());
  if (
    Number(disk.bavail) * Number(disk.bsize) <
    bytes.length + 64 * 1024 * 1024
  )
    throw new AppError(507, "저장 공간이 부족합니다.");
  let written = false;
  try {
    await db.transaction(async (tx) => {
      await lockBusiness(tx);
      await tx.query(
        "SELECT id FROM operation_locks WHERE id='uploads' FOR UPDATE",
      );
      const rec = await getRecord(kind, entityId, user, tx);
      if (rec.privacy_erased_at)
        throw new AppError(410, "파기된 자료에 첨부할 수 없습니다.");
      if (
        user.role === "engineer" &&
        ["tickets", "inspections"].includes(kind) &&
        rec.assignee_id &&
        rec.assignee_id !== user.id
      )
        throw new AppError(403, "담당 업무에만 첨부할 수 있습니다.");
      const [usage] = await tx.query(
        "SELECT coalesce(sum(size_bytes),0)::bigint bytes FROM documents WHERE purged_at IS NULL",
      );
      const maximum =
        (Number(process.env.UPLOAD_STORAGE_LIMIT_MB) || 10240) * 1024 * 1024;
      if (Number(usage.bytes) + bytes.length > maximum)
        throw new AppError(507, "첨부 저장 용량 한도를 초과했습니다.");
      await writeFile(documentPath(id), bytes, { flag: "wx", mode: 0o600 });
      written = true;
      await tx.query(
        "INSERT INTO documents(id,entity_kind,entity_id,name,mime_type,size_bytes,storage_key,uploaded_by,classification,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          kind,
          entityId,
          [...file.name]
            .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
            .join("")
            .slice(0, 150) || "attachment",
          mime,
          bytes.length,
          id,
          user.id,
          classification,
          createHash("sha256").update(bytes).digest("hex"),
        ],
      );
      await audit(tx, user.id, "upload", kind, entityId, {
        document_id: id,
        classification,
      });
    });
  } catch (e) {
    if (written) await unlink(documentPath(id)).catch(() => {});
    throw e;
  }
  const scan = await scanBytes(bytes);
  await db.query(
    "UPDATE documents SET scan_status=$2,scan_error=$3,scanned_at=now() WHERE id=$1",
    [id, scan.status, scan.error || null],
  );
  await securityLog(
    user,
    { action: "upload", kind, ids: [entityId, id] },
    request,
  );
  return { id, classification, scan_status: scan.status };
}
export async function createDownloadGrant(
  user: User,
  id: string,
  reason: string,
  request?: Request,
) {
  const db = await getDb(),
    [doc] = await db.query<DocumentRow>("SELECT * FROM documents WHERE id=$1", [
      id,
    ]);
  if (!doc) throw new AppError(404, "첨부 자료를 찾을 수 없습니다.");
  requireDocumentAccess(user.role, doc);
  const token = randomBytes(32).toString("hex"),
    key = createHash("sha256").update(token).digest("hex");
  await db.query(
    "INSERT INTO download_grants(id,user_id,document_id,reason,expires_at) VALUES ($1,$2,$3,$4,now()+interval '5 minutes')",
    [key, user.id, id, reason],
  );
  await securityLog(
    user,
    {
      action: "request_download",
      kind: doc.entity_kind,
      ids: [doc.entity_id, id],
      reason,
    },
    request,
  );
  return { url: "/api/documents/" + id + "?grant=" + token };
}
export async function downloadDocument(
  user: User,
  id: string,
  q: URLSearchParams,
  request?: Request,
) {
  const db = await getDb(),
    [doc] = await db.query<DocumentRow>("SELECT * FROM documents WHERE id=$1", [
      id,
    ]);
  if (!doc) throw new AppError(404, "첨부 자료를 찾을 수 없습니다.");
  requireDocumentAccess(user.role, doc);
  await getRecord(doc.entity_kind, doc.entity_id, user);
  let reason = "사내 공유 자료 확인";
  if (doc.classification !== "internal") {
    const token = q.get("grant") || "",
      key = createHash("sha256").update(token).digest("hex");
    const [grant] = await db.query(
      "DELETE FROM download_grants WHERE id=$1 AND user_id=$2 AND document_id=$3 AND expires_at>now() RETURNING reason",
      [key, user.id, id],
    );
    if (!grant) throw new AppError(403, "다운로드 사유를 등록해 주세요.");
    reason = grant.reason;
  }
  const file = await open(
    documentPath(doc.storage_key),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const stat = await file.stat();
  if (stat.size !== Number(doc.size_bytes)) {
    await file.close();
    throw new AppError(409, "파일 크기가 저장된 기록과 다릅니다.");
  }
  try {
    await securityLog(
      user,
      {
        action: "download",
        kind: doc.entity_kind,
        ids: [doc.entity_id, id],
        reason,
      },
      request,
    );
  } catch (e) {
    await file.close();
    throw e;
  }
  return {
    doc,
    stream: Readable.toWeb(
      file.createReadStream(),
    ) as ReadableStream<Uint8Array>,
  };
}
export async function scanPendingDocuments() {
  const db = await getDb(),
    docs = await db.query(
      "SELECT id,storage_key FROM documents WHERE deleted_at IS NULL AND (scan_status='pending' OR (scan_status='error' AND scanned_at<now()-interval '5 minutes')) ORDER BY created_at LIMIT 10",
    );
  for (const doc of docs) {
    let result;
    try {
      const bytes = await readFile(documentPath(doc.storage_key));
      result = {
        ...(await scanBytes(bytes)),
        sha: createHash("sha256").update(bytes).digest("hex"),
      };
    } catch {
      result = { status: "error", error: "file_unavailable", sha: null };
    }
    await db.query(
      "UPDATE documents SET scan_status=$2,scan_error=$3,sha256=coalesce(sha256,$4),scanned_at=now() WHERE id=$1 AND deleted_at IS NULL",
      [doc.id, result.status, result.error || null, result.sha],
    );
  }
  return docs.length;
}
