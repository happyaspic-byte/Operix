import { mkdir, statfs } from "node:fs/promises";
import { getDb, poolMetrics } from "./db";
import { documentRoot } from "./documents";
export async function healthStatus() {
  const db = await getDb();
  await db.query("SELECT 1 FROM schema_migrations LIMIT 1");
  await mkdir(documentRoot(), { recursive: true, mode: 0o700 });
  const disk = await statfs(documentRoot()),
    free = Number(disk.bavail) * Number(disk.bsize),
    [worker] = await db.query("SELECT * FROM job_runs WHERE id='worker'"),
    [backup] = await db.query(
      "SELECT * FROM backup_runs WHERE status='completed' ORDER BY completed_at DESC LIMIT 1",
    );
  const workerRequired = process.env.WORKER_REQUIRED === "1",
    backupRequired = process.env.BACKUP_REQUIRED === "1",
    workerOk =
      !workerRequired ||
      (!!worker?.last_success &&
        Date.now() - Date.parse(worker.last_success) < 300000 &&
        !worker.last_error),
    backupHours = Math.max(1, Number(process.env.BACKUP_MAX_AGE_HOURS) || 26),
    backupOk =
      !backupRequired ||
      (!!backup?.completed_at &&
        Date.now() - Date.parse(backup.completed_at) < backupHours * 3600000);
  return {
    ok: free > 64 * 1024 * 1024 && workerOk && backupOk,
    database: "ok",
    storage_free_bytes: free,
    worker: { required: workerRequired, ok: workerOk, ...worker },
    backup: {
      required: backupRequired,
      ok: backupOk,
      maximum_age_hours: backupHours,
      last_success: backup?.completed_at || null,
    },
    pool: poolMetrics(),
  };
}
