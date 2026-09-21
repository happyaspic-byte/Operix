import { test } from "node:test";
import assert from "node:assert/strict";
import { backupHealth } from "../src/lib/backup-health.ts";
test("local and remote backup freshness are independent and encryption is required", () => {
  const now = Date.now(),
    fresh = new Date(now - 1000).toISOString(),
    stale = new Date(now - 27 * 3600000).toISOString();
  const options = {
    localRequired: true,
    remoteRequired: true,
    maximumAgeHours: 26,
    now,
  };
  assert.equal(
    backupHealth({ completed_at: fresh, encrypted: true }, null, options).ok,
    false,
  );
  assert.equal(
    backupHealth(
      { completed_at: fresh, encrypted: true },
      { completed_at: stale, replicated_at: fresh, encrypted: true },
      options,
    ).ok,
    false,
  );
  assert.equal(
    backupHealth(
      { completed_at: fresh, encrypted: false },
      { completed_at: fresh, replicated_at: fresh, encrypted: false },
      options,
    ).ok,
    false,
  );
  assert.equal(
    backupHealth(
      { completed_at: fresh, encrypted: true },
      { completed_at: fresh, replicated_at: fresh, encrypted: true },
      options,
    ).ok,
    true,
  );
  assert.equal(
    backupHealth(null, null, {
      ...options,
      localRequired: false,
      remoteRequired: false,
    }).ok,
    true,
  );
});
