import { test } from "node:test";
import assert from "node:assert/strict";
import { validDate } from "../src/lib/dates.ts";
import { validateEntity } from "../src/lib/validation.ts";
import { AppError } from "../src/lib/policy.ts";
import { queryDate } from "../src/lib/http.ts";

// These validation tests do not connect to any database.
test("Calendar input rejects year zero, which cannot be stored as a SQL date", () => {
  for (const date of ["0000-01-01", "0000-02-29", "0000-12-31"])
    assert.equal(validDate(date), false, date);
});

test("Calendar input preserves supported year boundaries and leap-day validation", () => {
  for (const date of ["0001-01-01", "0099-12-31", "2028-02-29", "9999-12-31"])
    assert.equal(validDate(date), true, date);
  for (const date of ["2026-02-29", "1900-02-29", "2026-04-31", "10000-01-01"])
    assert.equal(validDate(date), false, date);
});

test("Date filters reject year zero before SQL casts and preserve valid boundaries", () => {
  for (const date of ["0000-01-01", "0000-02-29", "0000-12-31", "2026-02-29"])
    assert.throws(
      () => queryDate(date),
      (error) => error instanceof AppError && error.status === 400,
      date,
    );
  for (const date of ["0001-01-01", "0099-12-31", "2028-02-29", "9999-12-31"])
    assert.equal(queryDate(date), date);
});

const referenceId = crypto.randomUUID();
const cases = [
  {
    kind: "assets",
    field: "observed_at",
    input: {
      site_id: referenceId,
      name: "Date boundary asset",
      product: "Server",
    },
  },
  ...["eol_date", "eos_date"].map((field) => ({
    kind: "assets",
    field,
    input: {
      site_id: referenceId,
      name: "Date boundary asset",
      product: "Server",
    },
  })),
  {
    kind: "contracts",
    field: "start_date",
    input: {
      customer_id: referenceId,
      name: "Date boundary contract",
      kind: "maintenance",
      term: "dated",
      end_date: "2028-02-29",
    },
  },
  {
    kind: "contracts",
    field: "end_date",
    input: {
      customer_id: referenceId,
      name: "Date boundary contract",
      kind: "maintenance",
      term: "dated",
    },
  },
  {
    kind: "maintenance_plans",
    field: "start_date",
    input: {
      asset_id: referenceId,
      name: "Date boundary plan",
      interval_months: "1",
    },
  },
  {
    kind: "inspections",
    field: "planned_date",
    input: { asset_id: referenceId, name: "Date boundary inspection" },
  },
];

for (const { kind, field, input } of cases) {
  test(`${kind}.${field} rejects year zero as a client error`, () => {
    assert.throws(
      () => validateEntity(kind, { ...input, [field]: "0000-01-01" }),
      (error) => error instanceof AppError && error.status === 400,
    );
    assert.equal(
      validateEntity(kind, { ...input, [field]: "0001-01-01" })[field],
      "0001-01-01",
    );
  });
}
