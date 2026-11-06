import { test, expect } from "@playwright/test";

test("asset edits show before and after in change history", async ({
  page,
}) => {
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
  const create = async (kind: string, data: Record<string, unknown>) => {
    const response = await page.request.post(`/api/data/${kind}`, {
      headers,
      data,
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  const suffix = Date.now().toString();
  const customer = await create("customers", { name: `이력 고객 ${suffix}` });
  const site = await create("sites", {
    customer_id: customer.id,
    name: `이력 사업장 ${suffix}`,
  });
  const asset = await create("assets", {
    site_id: site.id,
    name: `이전 자산 ${suffix}`,
    product: "Server",
  });
  await page.goto(`/assets/${asset.id}`);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor
    .getByLabel("자산명", { exact: false })
    .fill(`변경 자산 ${suffix}`);
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  await expect(
    page.getByText(`자산명: 이전 자산 ${suffix} → 변경 자산 ${suffix}`),
  ).toBeVisible();
});
