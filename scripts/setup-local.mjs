import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  console.log("Existing .env preserved.");
  process.exit(0);
}
const password = randomBytes(18).toString("base64url");
writeFileSync(
  ".env",
  `APP_URL=http://localhost:3000
SESSION_SECRET=${randomBytes(48).toString("hex")}
OPERIX_EMBEDDED=1
PGLITE_PATH=.data/operix
ADMIN_EMAIL=admin@operix.test
ADMIN_PASSWORD=${password}
SEED_DEMO=1
DEMO_PASSWORD=${password}
UPLOAD_DIR=storage/uploads
`,
  { mode: 0o600 },
);
console.log(
  "Local verification configuration created in .env. Demo login: admin@operix.test. The generated password is in ADMIN_PASSWORD in .env.",
);
