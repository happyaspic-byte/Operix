import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScript } from "./helpers/script-db.ts";

test(
  "runScript runs a script against the PGlite directory it is given whatever database the caller names",
  { timeout: 120000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "operix-script-db-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const elsewhere = join(dir, "elsewhere");

    // An address that never resolves, so a broken guard fails without reaching
    // any database.
    const result = await runScript(
      "migrate",
      {
        DATABASE_URL: "postgresql://nobody:none@db.invalid:5432/operix",
        OPERIX_EMBEDDED: "0",
        PGLITE_PATH: elsewhere,
      },
      dir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await readdir(dir)).includes("PG_VERSION"));
    await assert.rejects(access(elsewhere));
  },
);
