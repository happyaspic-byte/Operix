import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };

async function login(
  page: Page,
  email = process.env.ADMIN_EMAIL!,
  password = process.env.ADMIN_PASSWORD!,
) {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
}

async function inspection(page: Page) {
  const lookups = await (
    await page.request.get("/api/lookups?entity=assets")
  ).json();
  const response = await page.request.post("/api/data/inspections", {
    headers: origin,
    data: {
      name: "휴지통 점검 " + Date.now(),
      asset_ids: [lookups.assets[0].id],
      planned_date: "2026-09-08",
      status: "cancelled",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

test("inspection trash preserves records, disables changes and restores through filtered history", async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page);
  const record = await inspection(page);
  const rejected = await page.request.delete(
    "/api/data/inspections/" + record.id,
    {
      headers: { Origin: "https://untrusted.example" },
      data: { version: record.version },
    },
  );
  expect(rejected.status()).toBe(403);
  const unchanged = await (
    await page.request.get("/api/data/inspections/" + record.id)
  ).json();
  expect(unchanged.version).toBe(record.version);
  expect(unchanged.deleted_at).toBeNull();
  await page.goto("/inspections/" + record.id);
  const remove = page.getByRole("button", { name: "점검 삭제", exact: true });
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  await expect(
    page.getByRole("button", { name: "수정", exact: true }),
  ).toBeVisible();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("복원");
    await dialog.accept();
  });
  await remove.click();
  await expect(
    page.getByText("휴지통에 있는 점검입니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "수정", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "보고서 확정", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "후속 작업 열기", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: /^작업 기록/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "기록 추가", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: /^문서·보고서/ })
    .first()
    .click();
  await expect(page.getByLabel("첨부 파일", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: /^자산 관리/ })
    .first()
    .click();
  await expect(
    page.getByRole("button", { name: "자산 등록", exact: true }),
  ).toHaveCount(0);
  const deleted = (
    await (
      await page.request.get("/api/details/inspections/" + record.id)
    ).json()
  ).record;
  expect(deleted.deleted_at).toBeTruthy();
  expect(deleted.status).toBe("cancelled");
  expect(deleted.asset_ids).toEqual(record.asset_ids);

  await page.goto(
    "/inspections?" +
      new URLSearchParams({ q: record.name, status: "cancelled" }),
  );
  await expect(
    page.getByRole("link", { name: record.name, exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "휴지통", exact: true }).click();
  await expect(page).toHaveURL(/trash=1/);
  await expect(page.getByLabel("점검 검색", { exact: true })).toHaveValue(
    record.name,
  );
  await expect(page.getByLabel("상태 필터", { exact: true })).toHaveValue(
    "cancelled",
  );
  await expect(
    page.getByRole("link", { name: record.name, exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("button", { name: "휴지통", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByLabel("상태 필터", { exact: true })).toHaveValue(
    "cancelled",
  );
  await expect(
    page.getByRole("link", { name: record.name, exact: true }),
  ).toHaveCount(0);
  await page.goForward();
  await expect(
    page.getByRole("button", { name: "휴지통", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("link", { name: record.name, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "휴지통", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: record.name, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "점검 복원", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/trash=1/);
  await expect(page.getByLabel("상태 필터", { exact: true })).toHaveValue(
    "cancelled",
  );
  await page.getByRole("link", { name: record.name, exact: true }).click();
  await page.getByRole("button", { name: "점검 복원", exact: true }).click();
  await expect(
    page.getByText("휴지통에 있는 점검입니다.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "수정", exact: true }),
  ).toBeVisible();
  const restored = await (
    await page.request.get("/api/data/inspections/" + record.id)
  ).json();
  expect(restored.deleted_at).toBeNull();
  expect(restored.status).toBe("cancelled");
  expect(restored.asset_ids).toEqual(record.asset_ids);
});

test("accounts keep department and job title separate from roles and restore as suspended", async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page);
  await page.goto("/settings");
  const name = "휴지통 계정 " + Date.now();
  const email = "trash-" + Date.now() + "@example.test";
  await page
    .getByRole("button", { name: "임직원 계정 발급", exact: true })
    .click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("이름", { exact: true }).fill(name);
  await editor.getByLabel("이메일", { exact: true }).fill(email);
  await editor
    .getByLabel("초기 비밀번호", { exact: true })
    .fill("Synthetic-trash-account-123!");
  await expect(editor.getByLabel("부서 (선택)", { exact: true })).toBeVisible();
  await editor.getByLabel("부서 (선택)", { exact: true }).fill("기술지원부");
  await editor.getByLabel("직책 (선택)", { exact: true }).fill("팀장");
  await editor
    .getByLabel("권한 역할", { exact: true })
    .selectOption("engineer");
  await expect(editor.getByText(/부서와 직책은 조직 정보/)).toBeVisible();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const usersPanel = page.getByRole("region", { name: "사용자와 권한" });
  const row = usersPanel.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("기술지원부");
  await expect(row).toContainText("팀장");
  await row.getByRole("button", { name: name + " 수정", exact: true }).click();
  await expect(editor.getByLabel("부서 (선택)", { exact: true })).toHaveValue(
    "기술지원부",
  );
  await editor.getByLabel("직책 (선택)", { exact: true }).fill("부장");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(row).toContainText("부장");
  const ownRow = usersPanel
    .getByRole("row")
    .filter({ hasText: process.env.ADMIN_EMAIL! });
  await expect(ownRow.getByRole("button", { name: /삭제$/ })).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("복원");
    expect(dialog.message()).toContain("이력");
    await dialog.accept();
  });
  await row.getByRole("button", { name: name + " 삭제", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(
    usersPanel.getByRole("button", { name: "휴지통", exact: true }),
  ).toBeFocused();
  await usersPanel.getByRole("button", { name: "휴지통", exact: true }).click();
  await expect(row).toContainText("기술지원부");
  await expect(row).toContainText("부장");
  await expect(
    row.getByRole("button", { name: name + " 수정", exact: true }),
  ).toHaveCount(0);
  const handoffFrom = page.getByRole("combobox", {
    name: "기존 담당자",
    exact: true,
  });
  await expect(handoffFrom).toBeVisible();
  await expect(
    handoffFrom.locator("option").filter({ hasText: name }),
  ).toHaveCount(0);
  const current = await (await page.request.get("/api/settings")).json();
  const own = current.users.find(
    (user: any) => user.email === process.env.ADMIN_EMAIL,
  );
  await expect(handoffFrom.locator(`option[value="${own.id}"]`)).toHaveCount(1);
  await row.getByRole("button", { name: name + " 복원", exact: true }).click();
  await expect(row).toHaveCount(0);
  await usersPanel.getByRole("button", { name: "휴지통", exact: true }).click();
  await expect(row).toContainText("정지");
  await expect(row).toContainText("부장");
  const restored = (
    await (await page.request.get("/api/settings")).json()
  ).users.find((user: any) => user.email === email);
  expect(restored.active).toBe(false);
  expect(restored.department).toBe("기술지원부");
  expect(restored.job_title).toBe("부장");
});

test("engineers do not see inspection deletion or trash controls", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  const record = await inspection(page);
  const settings = await (await page.request.get("/api/settings")).json();
  const targetAccount = settings.users.find(
    (user: any) => user.email === process.env.ADMIN_EMAIL,
  );
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await login(page, "engineer@operix.test", process.env.DEMO_PASSWORD!);
  await page.goto("/inspections");
  await expect(
    page.getByRole("heading", { name: "점검·일정", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "휴지통", exact: true }),
  ).toHaveCount(0);
  await page.goto("/inspections/" + record.id);
  await expect(
    page.getByRole("heading", { name: record.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "점검 삭제", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "점검 복원", exact: true }),
  ).toHaveCount(0);
  for (const [method, url, data] of [
    [
      "DELETE",
      "/api/data/inspections/" + record.id,
      { version: record.version },
    ],
    [
      "POST",
      "/api/data/inspections/" + record.id + "/restore",
      { version: record.version },
    ],
    ["GET", "/api/data/inspections?trash=1", undefined],
    [
      "DELETE",
      "/api/settings",
      { id: targetAccount.id, version: targetAccount.version },
    ],
    [
      "PATCH",
      "/api/settings",
      { id: targetAccount.id, version: targetAccount.version },
    ],
  ] as const) {
    const denied = await page.request.fetch(url, {
      method,
      headers: origin,
      ...(data ? { data } : {}),
    });
    expect(denied.status(), await denied.text()).toBe(403);
  }
});
