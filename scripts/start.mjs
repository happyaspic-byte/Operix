import "./runtime-guard.mjs";
import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
if (!existsSync(".next/standalone/server.js"))
  throw new Error("Build first: npm run build");
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
if (existsSync("public"))
  cpSync("public", ".next/standalone/public", { recursive: true });
const env = { ...process.env, HOSTNAME: "0.0.0.0" };
if (env.PGLITE_PATH && !env.PGLITE_PATH.startsWith("memory://"))
  env.PGLITE_PATH = resolve(env.PGLITE_PATH);
if (env.UPLOAD_DIR) env.UPLOAD_DIR = resolve(env.UPLOAD_DIR);
env.SECURITY_LOG_DIR = resolve(env.SECURITY_LOG_DIR || "storage/security");
const child = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit",
  env,
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
