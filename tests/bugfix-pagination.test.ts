import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Database } from "../src/lib/db.ts";
import { listRecords } from "../src/lib/records.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";
import { isolatedDatabase } from "./helpers/isolated-db.ts";

let db: Database;
let fixture: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
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
  fixture = await isolatedDatabase();
  db = fixture.db;
  for (const [index, id] of ids.entries())
    await db.query("INSERT INTO customers(id,name) VALUES ($1,$2)", [
      id,
      `${marker}-${index}`,
    ]);
});

after(async () => {
  await fixture?.close();
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
  ...["page", "limit"].flatMap((key) =>
    [
      "invalid",
      "0",
      "-1",
      "",
      "01",
      "+1",
      " 1",
      "1 ",
      "1e2",
      "1.5",
      "Infinity",
    ].map((value) => ({ [key]: value })),
  ),
  { page: "1.5", limit: "1" },
  { page: "1.5", limit: "20" },
  { page: "1e100" },
  { page: "9007199254740991", limit: "100" },
  { page: "100001" },
  { limit: "101" },
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

test("Only omitted pagination values receive defaults", async () => {
  const defaults = await list({});
  assert.equal(defaults.page, 1);
  assert.equal(defaults.limit, 20);
  assert.deepEqual(
    defaults.rows.map((row) => row.id),
    ids,
  );
  const pageOnly = await list({ page: "2" });
  assert.equal(pageOnly.page, 2);
  assert.equal(pageOnly.limit, 20);
  assert.deepEqual(pageOnly.rows, []);
  const limitOnly = await list({ limit: "1" });
  assert.equal(limitOnly.page, 1);
  assert.equal(limitOnly.limit, 1);
  assert.deepEqual(
    limitOnly.rows.map((row) => row.id),
    [ids[0]],
  );
});

test("Maximum allowed pagination bounds preserve totals and empty pages", async () => {
  const upper = await list({ limit: "100" });
  assert.equal(upper.limit, 100);
  assert.deepEqual(
    upper.rows.map((row) => row.id),
    ids,
  );
  const last = await list({ page: "100000", limit: "100" });
  assert.equal(last.page, 100000);
  assert.equal(last.limit, 100);
  assert.equal(last.total, 3);
  assert.deepEqual(last.rows, []);
});
