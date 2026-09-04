import { runJobs } from "../src/lib/jobs.ts";
import { getDb } from "../src/lib/db.ts";
async function tick() {
  try {
    console.log(
      JSON.stringify({
        job: "scheduler",
        at: new Date().toISOString(),
        ...(await runJobs()),
      }),
    );
  } catch (e) {
    console.error("Scheduler failed", e);
    if (process.argv.includes("--once")) process.exitCode = 1;
  }
}
await tick();
if (process.argv.includes("--once")) await (await getDb()).close();
else {
  if (!process.env.DATABASE_URL)
    throw new Error("Separate workers require PostgreSQL DATABASE_URL");
  setInterval(tick, 60_000);
}
