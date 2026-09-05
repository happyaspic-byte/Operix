import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { signSecurityRecord } from "../src/lib/security.ts";
const root = process.env.SECURITY_LOG_DIR || "storage/security";
let count = 0;
for (const file of (await readdir(root))
  .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
  .sort()) {
  let previous = "";
  for await (const line of createInterface({
    input: createReadStream(join(root, file)),
    crlfDelay: Infinity,
  })) {
    if (!line) continue;
    const { signature, ...record } = JSON.parse(line);
    if (
      record.previous_hash !== previous ||
      signSecurityRecord(record) !== signature
    )
      throw new Error("Security journal integrity verification failed");
    previous = signature;
    count++;
  }
}
console.log(
  JSON.stringify({
    verified_records: count,
    scope:
      "Existing signed files only; compare offsite inventories to detect whole-file removal.",
  }),
);
