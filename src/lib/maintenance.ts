import { errorSummary } from "./error-log";

// One failing job must not skip the rest; the caller gets the failed names.
export async function runMaintenanceJobs(
  jobs: Array<[string, () => Promise<unknown>]>,
  log: (line: string) => void = console.error,
): Promise<string[]> {
  const failed: string[] = [];
  for (const [job, run] of jobs) {
    try {
      await run();
    } catch (error) {
      failed.push(job);
      log(
        JSON.stringify({
          event: "operix.worker.job_failed",
          job,
          ...errorSummary(error),
        }),
      );
    }
  }
  return failed;
}

// The worker holds its lease while it records the outcome, so a failing update
// must neither crash it nor leave the lease held: the fallback releases the
// lease and leaves a marker that readiness reports. Never throws; resolves to
// whether the outcome itself was recorded, whether or not the fallback worked.
export async function recordMaintenanceOutcome(
  db: { query: (sql: string, params?: any[]) => Promise<unknown> },
  outcome: { failed: string[]; durationMs: number },
  log: (line: string) => void = console.error,
): Promise<boolean> {
  const logFailure = (error: unknown, stage?: string) =>
    log(
      JSON.stringify({
        event: "operix.worker.status_failed",
        ...(stage ? { stage } : {}),
        ...errorSummary(error),
      }),
    );
  try {
    if (outcome.failed.length)
      await db.query(
        "UPDATE job_runs SET heartbeat_at=now(),last_error=$1,started_at=NULL WHERE id='worker'",
        [`maintenance_failed:${outcome.failed.join(",")}`],
      );
    else
      await db.query(
        "UPDATE job_runs SET heartbeat_at=now(),last_success=now(),last_error=NULL,last_duration_ms=$1,started_at=NULL WHERE id='worker'",
        [outcome.durationMs],
      );
    return true;
  } catch (error) {
    logFailure(error);
    try {
      await db.query(
        "UPDATE job_runs SET last_error='status_update_failed',started_at=NULL WHERE id='worker'",
      );
    } catch (fallbackError) {
      logFailure(fallbackError, "fallback");
    }
    return false;
  }
}
