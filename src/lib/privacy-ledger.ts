import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { signSecurityRecord } from "./security";
import { AppError } from "./policy";
export type Tombstone = {
  id: string;
  subject_kind: "customers" | "users";
  subject_id: string;
  request_id: string;
  erased_at: string;
};
const ledgerPath = () =>
  join(
    resolve(process.env.SECURITY_LOG_DIR || "storage/security"),
    "privacy-tombstones.jsonl",
  );
export async function persistTombstone(record: Tombstone) {
  await mkdir(resolve(process.env.SECURITY_LOG_DIR || "storage/security"), {
    recursive: true,
    mode: 0o700,
  });
  await appendFile(
    ledgerPath(),
    JSON.stringify({ ...record, signature: signSecurityRecord(record) }) + "\n",
    { mode: 0o600, flush: true },
  );
}
export async function readTombstones() {
  let text;
  try {
    text = await readFile(ledgerPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { signature, ...record } = JSON.parse(line);
      if (
        signature !== signSecurityRecord(record) ||
        !["customers", "users"].includes(record.subject_kind)
      )
        throw new AppError(409, "개인정보 파기 기록 서명을 확인해 주세요.");
      return record as Tombstone;
    });
}
