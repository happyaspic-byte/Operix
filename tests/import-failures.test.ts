import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { isolatedDatabase } from "./helpers/isolated-db.ts";
import {
  previewImport,
  commitImport,
  importFailureBytes,
} from "../src/lib/imports.ts";
import { AppError } from "../src/lib/policy.ts";
import type { User } from "../src/lib/auth.ts";

const user: User = {
  id: crypto.randomUUID(),
  email: "failure-export@example.test",
  name: "Synthetic admin",
  role: "admin",
  active: true,
};
let isolated: Awaited<ReturnType<typeof isolatedDatabase>>;
before(async () => {
  process.env.FILE_SCAN_MODE = "test";
  isolated = await isolatedDatabase();
  await isolated.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) VALUES ($1,$2,$3,$4,'test')",
    [user.id, user.email, user.name, user.role],
  );
});
after(async () => {
  await isolated?.close();
});

test("exports only rejected original rows and supports corrected re-import", async () => {
  const preview = await previewImport(
    user,
    "customers",
    new File(
      ["고객사명,업종\nSynthetic valid,industry\n\n, =SUM(1) "],
      "input.csv",
    ),
  );
  assert.equal(preview.rows.length, 2);
  const failed = preview.rows[1];
  assert.equal(failed.action, "error");
  assert.equal(failed.row, 4);
  await assert.rejects(
    () => commitImport(user, preview.batch_id),
    (e: unknown) => e instanceof AppError && e.status === 400,
  );
  const csv = (
    await importFailureBytes(user, preview.batch_id, "csv")
  ).toString("utf8");
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"4"'));
  assert.ok(csv.includes(failed.error));
  assert.ok(csv.includes("' =SUM(1) "));
  assert.ok(!csv.includes("Synthetic valid"));
  const xlsx = await importFailureBytes(user, preview.batch_id, "xlsx");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(xlsx as never);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getCell("C1").value, "고객사명");
  assert.equal(sheet.getCell("D1").value, "업종");
  assert.equal(sheet.getCell("A2").value, 4);
  assert.equal(sheet.getCell("B2").value, failed.error);
  assert.equal(sheet.getCell("D2").value, " =SUM(1) ");
  sheet.getCell("C2").value = "Synthetic corrected";
  const corrected = await workbook.xlsx.writeBuffer();
  const again = await previewImport(
    user,
    "customers",
    new File([Buffer.from(corrected)], "corrected.xlsx"),
    { name: "고객사명" },
  );
  assert.equal(again.valid, true, JSON.stringify(again.rows));
  assert.ok(!again.headers.includes("행 번호"));
  assert.ok(!again.headers.includes("오류"));
  const ignored = await previewImport(
    user,
    "customers",
    new File([Buffer.from(corrected)], "corrected.xlsx"),
    { name: "오류" },
  );
  assert.equal(ignored.valid, false);
});

test("failure downloads respect permission, ownership, expiry and commit cleanup", async () => {
  const preview = await previewImport(
    user,
    "customers",
    new File(["고객사명,업종\n,synthetic"], "input.csv"),
  );
  const viewer = { ...user, role: "viewer" as const };
  await assert.rejects(
    () => importFailureBytes(viewer, preview.batch_id, "csv"),
    (e: unknown) => e instanceof AppError && e.status === 403,
  );
  await assert.rejects(
    () =>
      importFailureBytes(
        { ...user, id: crypto.randomUUID() },
        preview.batch_id,
        "csv",
      ),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
  await isolated.db.query(
    "UPDATE import_batches SET expires_at=now()-interval '1 second' WHERE id=$1",
    [preview.batch_id],
  );
  await assert.rejects(
    () => importFailureBytes(user, preview.batch_id, "csv"),
    (e: unknown) => e instanceof AppError && e.status === 410,
  );
  const valid = await previewImport(
    user,
    "customers",
    new File(["고객사명\nSynthetic commit"], "input.csv"),
  );
  await commitImport(user, valid.batch_id);
  await assert.rejects(
    () => importFailureBytes(user, valid.batch_id, "csv"),
    (e: unknown) => e instanceof AppError && e.status === 404,
  );
});
