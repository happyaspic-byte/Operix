import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("rejected import rows can be downloaded", async ({ page }) => {
  await page.goto("/login");
  await page
    .getByLabel("이메일", { exact: true })
    .fill(process.env.ADMIN_EMAIL!);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await page.goto("/customers");
  await page.getByRole("button", { name: "가져오기", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "synthetic.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "고객사명,업종\nSynthetic valid,service\n,Synthetic bad",
    ),
  });
  await dialog.getByRole("button", { name: "미리보기 검증" }).click();
  await expect(dialog.getByText(/오류 1행/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "실패 행 내려받기 (CSV)" }).click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!, "utf8");
  expect(contents.startsWith("\uFEFF")).toBeTruthy();
  expect(contents).toContain('"행 번호","오류","고객사명","업종"');
  expect(contents).toContain('"3"');
  expect(contents).toContain("Synthetic bad");
  expect(contents).not.toContain("Synthetic valid");
});
