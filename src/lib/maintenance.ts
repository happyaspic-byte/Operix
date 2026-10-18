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
