import { assertSupportedNodeVersion } from "./runtime-version.mjs";
assertSupportedNodeVersion();
import { setTimeout as delay } from "node:timers/promises";
import { runJobs } from "../src/lib/jobs.ts";
import { runMaintenanceJobs } from "../src/lib/maintenance.ts";
import { getDb } from "../src/lib/db.ts";
import { scanPendingDocuments } from "../src/lib/documents.ts";
import { purgeDeletedFiles } from "../src/lib/privacy.ts";
const once = process.argv.includes("--once");
if (!once && !process.env.DATABASE_URL)
  throw new Error("Separate workers require PostgreSQL DATABASE_URL");
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => controller.abort());
const db = await getDb();
await db.query(
  "INSERT INTO job_runs(id) VALUES ('worker') ON CONFLICT DO NOTHING",
);
async function tick() {
  const start = Date.now();
  // Lease prevents two worker processes from claiming the same maintenance pass.
  const claimed = await db.query(
    "UPDATE job_runs SET heartbeat_at=now(),started_at=now() WHERE id='worker' AND (started_at IS NULL OR started_at<now()-interval '10 minutes') RETURNING id",
  );
  if (!claimed.length) return;
  let result: Awaited<ReturnType<typeof runJobs>> | undefined;
  const failed = await runMaintenanceJobs([
    [
      "runJobs",
      async () => {
        result = await runJobs();
      },
    ],
    ["purgeDeletedFiles", purgeDeletedFiles],
    ["scanPendingDocuments", scanPendingDocuments],
  ]);
  if (!failed.length) {
    await db.query(
      "UPDATE job_runs SET heartbeat_at=now(),last_success=now(),last_error=NULL,last_duration_ms=$1,started_at=NULL WHERE id='worker'",
      [Date.now() - start],
    );
    console.log(
      JSON.stringify({
        event: "operix.worker.completed",
        duration_ms: Date.now() - start,
        ...result,
      }),
    );
  } else {
    await db.query(
      "UPDATE job_runs SET heartbeat_at=now(),last_error=$1,started_at=NULL WHERE id='worker'",
      [`maintenance_failed:${failed.join(",")}`],
    );
    console.error(JSON.stringify({ event: "operix.worker.failed" }));
    if (once) process.exitCode = 1;
  }
}
do {
  await tick();
  if (once || controller.signal.aborted) break;
  try {
    await delay(60000, undefined, { signal: controller.signal });
  } catch {
    break;
  }
} while (!controller.signal.aborted);
await db.close();
