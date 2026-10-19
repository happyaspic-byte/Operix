import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);
// What scripts/seed.ts reads: a developer's shell must not decide what a test
// seeds, so these reach a script only through `env`.
const seedSettings = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "SEED_DEMO",
  "DEMO_PASSWORD",
];

// Runs scripts/<name>.ts in a process of its own, as `npm run db:migrate` and
// the other script commands do, against the PGlite directory `pgliteDir`. `env`
// overrides what the script would inherit and `args` follow the script path.
export async function runScript(
  name: string,
  env: Record<string, string>,
  pgliteDir: string,
  ...args: string[]
) {
  const inherited = { ...process.env };
  for (const key of seedSettings) delete inherited[key];
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--import", "tsx", `scripts/${name}.ts`, ...args],
      {
        cwd: root,
        env: {
          ...inherited,
          CI: "true",
          DATABASE_URL: "",
          OPERIX_EMBEDDED: "1",
          PGLITE_PATH: pgliteDir,
          UPLOAD_DIR: join(pgliteDir, "uploads"),
          SESSION_SECRET: "script-test-session-secret-0123456789abcdef",
          ...env,
        },
        timeout: 90000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error: any) {
    // A timeout or a failure to start is not a script exit status.
    if (typeof error.code !== "number") throw error;
    return {
      code: error.code as number,
      stdout: error.stdout as string,
      stderr: error.stderr as string,
    };
  }
}

// PGlite serves one process at a time: only call this while no script runs.
export async function inDatabase<T>(
  fn: (db: PGlite) => Promise<T>,
  pgliteDir: string,
) {
  const db = new PGlite(pgliteDir);
  try {
    await db.waitReady;
    return await fn(db);
  } finally {
    await db.close();
  }
}
