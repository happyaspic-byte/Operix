import { test, expect } from "@playwright/test";

test("방문 준비 체크 항목은 새로고침 후에도 유지됩니다", async ({ page }) => {
  await page.goto("/login");
  await page
    .getByLabel("이메일", { exact: true })
    .fill(process.env.ADMIN_EMAIL!);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
  const headers = { Origin: process.env.APP_URL || "http://localhost:3000" };
  async function create(kind: string, data: Record<string, unknown>) {
    const response = await page.request.post("/api/data/" + kind, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  }
  const suffix = Date.now().toString();
  const customer = await create("customers", { name: "준비표 고객 " + suffix });
  const site = await create("sites", {
    name: "준비표 현장 " + suffix,
    customer_id: customer.id,
  });
  const asset = await create("assets", {
    name: "준비표 자산 " + suffix,
    site_id: site.id,
    product: "Server",
  });
  const inspection = await create("inspections", {
    name: "준비표 점검 " + suffix,
    asset_ids: [asset.id],
    planned_date: "2026-12-01",
  });
  await page.goto("/inspections/" + inspection.id);
  await page.getByRole("link", { name: "방문 준비표" }).click();
  const checkbox = page.getByRole("checkbox", { name: "담당자 연락 확인" });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await expect(checkbox).toBeChecked();
});
