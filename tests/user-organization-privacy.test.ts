import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import {
  inventory,
  previewErasure,
  executeErasure,
} from "../src/lib/privacy.ts";
import type { User } from "../src/lib/auth.ts";

test("organization changes invalidate erasure previews and approved erasure clears department and job title", async () => {
  const isolated = await isolatedDatabase();
  const oldDir = process.env.SECURITY_LOG_DIR;
  const dir = await mkdtemp(join(tmpdir(), "operix-organization-privacy-"));
  process.env.SECURITY_LOG_DIR = dir;
  const user: User = {
    id: crypto.randomUUID(),
    name: "Organization admin",
    email: "organization-admin@operix.test",
    role: "admin",
    active: true,
  };
  const target = crypto.randomUUID();
  try {
    await isolated.db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,'admin','unused')",
      [user.id, user.email, user.name],
    );
    await isolated.db.query(
      "INSERT INTO users(id,email,name,role,password_hash,active,department,job_title) VALUES($1,'organization-target@operix.test','Organization target','viewer','unused',false,'Synthetic operations','Synthetic lead')",
      [target],
    );
    await isolated.db.query(
      "UPDATE privacy_policies SET purpose='Synthetic verification',lawful_basis='Synthetic request',retention_days=30,approved_by=$1,approved_at=now() WHERE resource_kind='users'",
      [user.id],
    );
    const before = await inventory(isolated.db, "users", target);
    await isolated.db.query(
      "UPDATE users SET department='Synthetic support' WHERE id=$1",
      [target],
    );
    const after = await inventory(isolated.db, "users", target);
    assert.notEqual(before.fingerprint, after.fingerprint);
    const preview = await previewErasure(
      user,
      "users",
      target,
      "Synthetic erasure request",
      "Synthetic lawful basis",
    );
    await executeErasure(user, preview.id);
    const [erased] = await isolated.db.query(
      "SELECT department,job_title,privacy_erased_at FROM users WHERE id=$1",
      [target],
    );
    assert.ok(erased.privacy_erased_at);
    assert.equal(erased.department, "");
    assert.equal(erased.job_title, "");
  } finally {
    await isolated.close();
    if (oldDir === undefined) delete process.env.SECURITY_LOG_DIR;
    else process.env.SECURITY_LOG_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  }
});
