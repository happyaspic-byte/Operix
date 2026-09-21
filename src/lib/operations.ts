import { backupHealth } from "./backup-health";
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
    [localBackup] = await db.query(
      "SELECT * FROM backup_runs WHERE status='completed' AND encrypted=true ORDER BY completed_at DESC LIMIT 1",
    ),
    [remoteBackup] = await db.query(
      "SELECT * FROM backup_runs WHERE status='completed' AND encrypted=true AND replicated_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
  const workerRequired = process.env.WORKER_REQUIRED === "1",
    workerOk =
      !workerRequired ||
      (!!worker?.last_success &&
        Date.now() - Date.parse(worker.last_success) < 300000 &&
        !worker.last_error),
    backup = backupHealth(localBackup ?? null, remoteBackup ?? null, {
      localRequired: process.env.BACKUP_REQUIRED === "1",
      remoteRequired: process.env.BACKUP_REMOTE_REQUIRED === "1",
      maximumAgeHours: Math.max(
        1,
        Number(process.env.BACKUP_MAX_AGE_HOURS) || 26,
      ),
    });
  return {
    ok: free > 64 * 1024 * 1024 && workerOk && backup.ok,
    database: "ok",
    storage_free_bytes: free,
    worker: { required: workerRequired, ok: workerOk, ...worker },
    backup,
    pool: poolMetrics(),
  };
}
