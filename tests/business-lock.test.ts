import { test } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import { lockBusiness } from "../src/lib/transactions.ts";
import { failure } from "../src/lib/http.ts";
test(
  "busy writes time out, roll back and leave reads available",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15000 },
  async () => {
    const isolated = await isolatedDatabase();
    const db = isolated.db;
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      acquired = r;
    });
    const holder = db.transaction(async (tx) => {
      await lockBusiness(tx);
      acquired();
      await held;
    });
    try {
      await ready;
      const started = Date.now();
      const contender = db.transaction(async (tx) => {
        await tx.query(
          "INSERT INTO customers(id,name) VALUES('lock-probe','Synthetic lock probe')",
        );
        await lockBusiness(tx);
      });
      // Attach the rejection handler immediately while the reader runs.
      const rejection = assert.rejects(contender, (asyncError) => {
        const response = failure(asyncError);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("Retry-After"), "5");
        return true;
      });
      const readStart = Date.now();
      await db.query("SELECT count(*) FROM customers");
      assert.ok(
        Date.now() - readStart < 2000,
        "reads must not wait for the business lock",
      );
      await rejection;
      assert.ok(
        Date.now() - started < 8000,
        "writes must be bounded to five seconds plus scheduling allowance",
      );
      assert.equal(
        (await db.query("SELECT id FROM customers WHERE id='lock-probe'"))
          .length,
        0,
      );
    } finally {
      release();
      await holder;
      await isolated.close();
    }
  },
);
test("lock contention returns a retry hint without database details", async () => {
  const response = failure({ code: "55P03", message: "private SQL details" });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.doesNotMatch(await response.text(), /private SQL/);
});

test(
  "a 1000-row import commits atomically while concurrent reads remain available",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const { commitImport } = await import("../src/lib/imports.ts");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const isolated = await isolatedDatabase();
    const db = isolated.db;
    const user = {
      id: crypto.randomUUID(),
      name: "Import probe",
      email: "import-probe@operix.test",
      role: "admin" as const,
      active: true,
    };
    const batch = crypto.randomUUID();
    try {
      await db.query(
        "INSERT INTO users(id,name,email,role,password_hash) VALUES($1,$2,$3,'admin','unused')",
        [user.id, user.name, user.email],
      );
      await db.query(
        "INSERT INTO import_batches(id,user_id,entity_kind,payload,expires_at) VALUES($1,$2,'customers',$3,now()+interval '1 hour')",
        [
          batch,
          user.id,
          JSON.stringify(
            Array.from({ length: 1000 }, (_, i) => ({
              action: "create",
              data: { name: "Synthetic import " + i },
            })),
          ),
        ],
      );
      let done = false;
      const started = Date.now();
      const samples: number[] = [];
      const writer = commitImport(user, batch).finally(() => {
        done = true;
      });
      const reader = (async () => {
        while (!done) {
          const start = Date.now();
          const [row] = await db.query("SELECT count(*)::int n FROM customers");
          samples.push(Date.now() - start);
          assert.ok(
            row.n === 0 || row.n === 1000,
            "readers must never observe a partial import",
          );
        }
      })();
      const [summary] = await Promise.all([writer, reader]);
      assert.equal(summary.count, 1000);
      assert.equal(
        (await db.query("SELECT count(*)::int n FROM customers"))[0].n,
        1000,
      );
      samples.sort((a, b) => a - b);
      const metrics = {
        rows: 1000,
        commit_ms: Date.now() - started,
        concurrent_reads: samples.length,
        read_p95_ms: samples[Math.floor(samples.length * 0.95)] ?? null,
        read_max_ms: samples.at(-1) ?? null,
      };
      await mkdir(".data", { recursive: true });
      await writeFile(
        ".data/contention-performance.json",
        JSON.stringify(metrics, null, 2),
      );
      console.log("PostgreSQL import probe: " + JSON.stringify(metrics));
    } finally {
      await isolated.close();
    }
  },
);
