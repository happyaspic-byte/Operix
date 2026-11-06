import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { saveRecord } from "../src/lib/records.ts";
import { assetHistory, historySnapshot } from "../src/lib/asset-history.ts";
import { previewErasure, executeErasure } from "../src/lib/privacy.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";

test("asset, component and VM diffs, comparison, permission, validation and erasure", async () => {
  const isolated = await isolatedDatabase();
  const dir = await mkdtemp(join(tmpdir(), "operix-history-"));
  const old = process.env.SECURITY_LOG_DIR;
  process.env.SECURITY_LOG_DIR = dir;
  const user: User = {
    id: crypto.randomUUID(),
    email: "history-admin@example.test",
    name: "History admin",
    role: "admin",
    active: true,
  };
  try {
    await isolated.db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'unused')",
      [user.id, user.email, user.name, user.role],
    );
    const customer = await saveRecord("customers", user, {
      name: "Synthetic history customer",
    });
    const site = await saveRecord("sites", user, {
      customer_id: customer.id,
      name: "Synthetic site",
    });
    const asset = await saveRecord("assets", user, {
      site_id: site.id,
      name: "Old asset",
      product: "Server",
      software_version: "1",
    });
    const component = await saveRecord("components", user, {
      asset_id: asset.id,
      name: "Old component",
    });
    const vm = await saveRecord("vms", user, {
      asset_id: asset.id,
      name: "Old VM",
      vcpu: 1,
      memory_gb: 1,
      disk_gb: 1,
    });
    await isolated.db.query(
      "UPDATE audit_logs SET created_at='2026-01-01T00:00:00Z' WHERE entity_id=ANY($1::text[])",
      [[asset.id, component.id, vm.id]],
    );
    await saveRecord(
      "assets",
      user,
      {
        site_id: site.id,
        name: "New asset",
        product: "Server",
        software_version: "2",
        version: asset.version,
      },
      asset.id,
    );
    await saveRecord(
      "components",
      user,
      { asset_id: asset.id, name: "New component", version: component.version },
      component.id,
    );
    await saveRecord(
      "vms",
      user,
      {
        asset_id: asset.id,
        name: "New VM",
        vcpu: 2,
        memory_gb: 1,
        disk_gb: 1,
        version: vm.version,
      },
      vm.id,
    );
    await isolated.db.query(
      "UPDATE audit_logs SET created_at='2026-01-02T00:00:00Z' WHERE entity_id=ANY($1::text[]) AND action='update'",
      [[asset.id, component.id, vm.id]],
    );
    const result = await assetHistory(
      asset.id,
      user,
      new URLSearchParams("compare=2026-01-01,2026-01-02"),
    );
    for (const [kind, before, after] of [
      ["assets", "Old asset", "New asset"],
      ["components", "Old component", "New component"],
      ["vms", "Old VM", "New VM"],
    ]) {
      assert.ok(
        result.events.some(
          (event) =>
            event.kind === kind &&
            event.diffs.some(
              (diff) =>
                diff.key === "name" &&
                diff.before === before &&
                diff.after === after,
            ),
        ),
      );
      assert.ok(
        result.comparison?.records.some(
          (record) =>
            record.kind === kind &&
            record.diffs.some(
              (diff) =>
                diff.key === "name" &&
                diff.before === before &&
                diff.after === after,
            ),
        ),
      );
    }
    assert.ok(
      result.events.some((event) =>
        event.diffs.some((diff) => diff.key === "software_version"),
      ),
    );
    assert.ok(!JSON.stringify(result).includes("version_before"));
    const snapshot = historySnapshot("assets", {
      name: "safe",
      password: "hidden",
      version: 8,
      created_at: "hidden",
    });
    assert.ok(!JSON.stringify(snapshot).includes("hidden"));
    await assert.rejects(
      assetHistory(
        asset.id,
        { ...user, role: "viewer" },
        new URLSearchParams(),
      ),
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    for (const q of [
      "limit=0",
      "limit=101",
      "offset=-1",
      "offset=1.5",
      "offset=Infinity",
    ])
      await assert.rejects(
        assetHistory(asset.id, user, new URLSearchParams(q)),
        (e: unknown) => e instanceof AppError && e.status === 400,
      );
    const target = crypto.randomUUID();
    await isolated.db.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,'viewer','unused')",
      [target, "erase-history@example.test", "Synthetic Erased Name"],
    );
    await isolated.db.query(
      "UPDATE privacy_policies SET purpose='Synthetic verification',lawful_basis='Synthetic request',retention_days=30,approved_by=$1,approved_at=now() WHERE resource_kind='users'",
      [user.id],
    );
    await saveRecord(
      "assets",
      user,
      {
        site_id: site.id,
        name: "New asset",
        product: "Server",
        notes: "Synthetic Erased Name",
        version: asset.version + 1,
      },
      asset.id,
    );
    const preview = await previewErasure(
      user,
      "users",
      target,
      "Synthetic erasure request",
      "Synthetic lawful basis",
    );
    await executeErasure(user, preview.id);
    await saveRecord(
      "assets",
      user,
      {
        site_id: site.id,
        name: "New asset",
        product: "Server",
        notes: "Synthetic Erased Name",
        version: asset.version + 2,
      },
      asset.id,
    );
    const erased = await assetHistory(asset.id, user, new URLSearchParams());
    assert.ok(!JSON.stringify(erased).includes("Synthetic Erased Name"));
    assert.ok(erased.events.some((event) => event.redacted));
  } finally {
    await isolated.close();
    if (old === undefined) delete process.env.SECURITY_LOG_DIR;
    else process.env.SECURITY_LOG_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
