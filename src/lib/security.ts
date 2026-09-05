import { createHmac } from "node:crypto";
import { appendFile, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isIP } from "node:net";
import { headers as requestHeaders } from "next/headers";
import { getDb } from "./db";
import type { User } from "./auth";
import { AppError } from "./policy";
export type AccessEvent = {
  action: string;
  kind: string;
  ids?: string[];
  outcome?: "allowed" | "denied" | "failed";
  reason?: string;
};
export function trustedAddress(
  h: Headers | { get: (name: string) => string | null },
) {
  if (process.env.TRUST_PROXY_HEADERS !== "1") return "unknown";
  const ip = h.get("x-operix-client-ip") || "";
  return isIP(ip) ? ip : "unknown";
}
export async function connectionInfo(request?: Request) {
  let h: Headers | Awaited<ReturnType<typeof requestHeaders>>;
  try {
    h = request?.headers || (await requestHeaders());
  } catch {
    return { address: "unknown", agent: "", requestId: crypto.randomUUID() };
  }
  return {
    address: trustedAddress(h),
    agent: (h.get("user-agent") || "").slice(0, 200),
    requestId: crypto.randomUUID(),
  };
}
export function signSecurityRecord(record: Record<string, unknown>) {
  const key = process.env.SECURITY_LOG_KEY || process.env.SESSION_SECRET;
  if (!key || key.length < 32)
    throw new Error("Security log signing key is required");
  return createHmac("sha256", key).update(JSON.stringify(record)).digest("hex");
}
async function lastSignature(path: string) {
  let file;
  try {
    file = await open(path, "r");
    const stat = await file.stat();
    if (!stat.size) return "";
    const size = Math.min(stat.size, 65536),
      bytes = Buffer.alloc(size);
    await file.read(bytes, 0, size, stat.size - size);
    const line = bytes.toString("utf8").trimEnd().split("\n").pop();
    return line ? (JSON.parse(line).signature as string) : "";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  } finally {
    await file?.close();
  }
}
export async function securityLog(
  user: Pick<User, "id"> | null,
  event: AccessEvent,
  request?: Request,
) {
  const context = await connectionInfo(request),
    occurredAt = new Date().toISOString(),
    db = await getDb();
  const root = resolve(process.env.SECURITY_LOG_DIR || "storage/security");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, occurredAt.slice(0, 10) + ".jsonl");
  await db.transaction(async (tx) => {
    await tx.query(
      "SELECT id FROM operation_locks WHERE id='security' FOR UPDATE",
    );
    const previous = await lastSignature(path);
    const record = {
      id: crypto.randomUUID(),
      user_id: user?.id || null,
      action: event.action,
      resource_kind: event.kind,
      resource_ids: (event.ids || []).slice(0, 100),
      outcome: event.outcome || "allowed",
      client_address: context.address,
      request_id: context.requestId,
      reason: (event.reason || "").slice(0, 500),
      occurred_at: occurredAt,
      previous_hash: previous,
    };
    const signature = signSecurityRecord(record);
    // The independently stored signed journal survives an application DB restore.
    await appendFile(path, JSON.stringify({ ...record, signature }) + "\n", {
      mode: 0o600,
      flush: true,
    });
    await tx.query(
      "INSERT INTO security_logs(id,user_id,action,resource_kind,resource_ids,outcome,client_address,request_id,reason,occurred_at,previous_hash,signature,mirrored_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())",
      [
        record.id,
        record.user_id,
        record.action,
        record.resource_kind,
        JSON.stringify(record.resource_ids),
        record.outcome,
        record.client_address,
        record.request_id,
        record.reason,
        occurredAt,
        previous,
        signature,
      ],
    );
  });
  return context.requestId;
}
export function verifySecurityLines(content: string) {
  let previous = "";
  let count = 0;
  for (const line of content.trim().split("\n").filter(Boolean)) {
    const { signature, ...record } = JSON.parse(line);
    if (
      record.previous_hash !== previous ||
      signSecurityRecord(record) !== signature
    )
      throw new AppError(409, "접속기록 서명 또는 연결이 일치하지 않습니다.");
    previous = signature;
    count++;
  }
  return { count, last_signature: previous };
}
