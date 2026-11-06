import { test, expect } from "@playwright/test";

const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };

test("주 연락처를 지정하면 고객 상세 목록에 배지와 우선 순서가 표시된다", async ({
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
  const suffix = Date.now().toString();
  const customerResponse = await page.request.post("/api/data/customers", {
    headers: origin,
    data: { name: "연락처 테스트 " + suffix },
  });
  expect(customerResponse.status()).toBe(201);
  const customer = await customerResponse.json();
  const firstResponse = await page.request.post("/api/data/customer_contacts", {
    headers: origin,
    data: { customer_id: customer.id, name: "가 담당자 " + suffix },
  });
  expect(firstResponse.status()).toBe(201);
  const secondResponse = await page.request.post(
    "/api/data/customer_contacts",
    {
      headers: origin,
      data: { customer_id: customer.id, name: "나 담당자 " + suffix },
    },
  );
  expect(secondResponse.status()).toBe(201);
  const second = await secondResponse.json();
  await page.goto("/customer_contacts/" + second.id);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("주 연락처", { exact: true }).check();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.goto("/customers/" + customer.id);
  await page
    .getByRole("button", { name: /고객 연락처/ })
    .first()
    .click();
  const rows = page.locator(".records-table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText(second.name);
  await expect(rows.first()).toContainText("주 연락처");
});
