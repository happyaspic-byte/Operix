import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getDb, type Database } from "../src/lib/db.ts";
import { listRecords } from "../src/lib/records.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";

// Use only an explicitly supplied test database, otherwise isolated memory.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "";
process.env.OPERIX_EMBEDDED = "1";
process.env.PGLITE_PATH = "memory://";

let db: Database;
const marker = `bugfix-pagination-${crypto.randomUUID()}`;
const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const user: User = {
  id: crypto.randomUUID(),
  email: `${marker}@example.com`,
  name: "Pagination viewer",
  role: "viewer",
  active: true,
};

before(async () => {
  db = await getDb();
  await db.exec(await readFile("db/001_initial.sql", "utf8"));
  for (const [index, id] of ids.entries())
    await db.query("INSERT INTO customers(id,name) VALUES ($1,$2)", [
      id,
      `${marker}-${index}`,
    ]);
});

after(async () => {
  if (!db) return;
  try {
    for (const id of ids)
      await db.query("DELETE FROM customers WHERE id=$1", [id]);
  } finally {
    await db.close();
  }
});

function list(params: Record<string, string>) {
  return listRecords(
    "customers",
    user,
    new URLSearchParams({
      q: marker,
      sort: "name",
      direction: "asc",
      ...params,
    }),
  );
}

const invalidParams: Record<string, string>[] = [
  { limit: "1.5" },
  { page: "1.5", limit: "1" },
  { page: "1.5", limit: "20" },
  { page: "Infinity" },
  { page: "1e100" },
  { page: "9007199254740991", limit: "100" },
];
for (const params of invalidParams) {
  test(`Invalid pagination returns a client error: ${JSON.stringify(params)}`, async () => {
    await assert.rejects(
      () => list(params),
      (error) => error instanceof AppError && error.status === 400,
    );
  });
}

test("Integer pages return distinct ordered records and the filtered total", async () => {
  const first = await list({ page: "1", limit: "2" });
  const second = await list({ page: "2", limit: "2" });
  assert.deepEqual(
    first.rows.map((row) => row.id),
    [ids[0], ids[1]],
  );
  assert.deepEqual(
    second.rows.map((row) => row.id),
    [ids[2]],
  );
  assert.equal(first.total, 3);
  assert.equal(second.total, 3);
  assert.equal(second.page, 2);
  assert.equal(second.limit, 2);
  assert.deepEqual((await list({ page: "3", limit: "2" })).rows, []);
});

test("Existing pagination defaults and integer bounds are preserved", async () => {
  const defaults: Record<string, string>[] = [
    {},
    { page: "invalid", limit: "invalid" },
    { page: "0", limit: "0" },
  ];
  for (const params of defaults) {
    const result = await list(params);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 20);
    assert.deepEqual(
      result.rows.map((row) => row.id),
      ids,
    );
  }
  const lower = await list({ page: "-1", limit: "-1" });
  assert.equal(lower.page, 1);
  assert.equal(lower.limit, 1);
  assert.deepEqual(
    lower.rows.map((row) => row.id),
    [ids[0]],
  );
  const upper = await list({ limit: "101" });
  assert.equal(upper.limit, 100);
  assert.deepEqual(
    upper.rows.map((row) => row.id),
    ids,
  );
});
