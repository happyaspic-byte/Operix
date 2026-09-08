import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };

async function login(page: Page) {
  await page.goto("/login");
  await page
    .getByLabel("이메일", { exact: true })
    .fill(process.env.ADMIN_EMAIL!);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
}

async function create(page: Page, kind: string, data: Record<string, unknown>) {
  const response = await page.request.post("/api/data/" + kind, {
    headers: origin,
    data,
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json();
}

async function fixture(page: Page) {
  const suffix = Date.now().toString();
  const customer = await create(page, "customers", {
    name: "복수 점검 고객 " + suffix,
  });
  const site = await create(page, "sites", {
    name: "복수 점검 사업장 " + suffix,
    customer_id: customer.id,
  });
  const first = await create(page, "assets", {
    name: "동일 이름 서버 " + suffix,
    asset_tag: "MULTI-A-" + suffix,
    site_id: site.id,
    product: "Server",
  });
  const second = await create(page, "assets", {
    name: first.name,
    asset_tag: "MULTI-B-" + suffix,
    site_id: site.id,
    product: "Server",
  });
  return { suffix, customer, site, first, second };
}

test("inspection assets can be searched, selected together, validated and edited", async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  const { suffix, first, second } = await fixture(page);
  const otherCustomer = await create(page, "customers", {
    name: "다른 고객 " + suffix,
  });
  const otherSite = await create(page, "sites", {
    name: "다른 사업장 " + suffix,
    customer_id: otherCustomer.id,
  });
  const otherAsset = await create(page, "assets", {
    name: "다른 고객 자산 " + suffix,
    asset_tag: "OTHER-" + suffix,
    site_id: otherSite.id,
    product: "Server",
  });

  await page.goto("/inspections");
  await page.getByRole("button", { name: "점검 등록", exact: true }).click();
  const editor = page.getByRole("dialog");
  await editor
    .getByLabel("점검명", { exact: false })
    .fill("복수 대상 점검 " + suffix);
  await editor.getByLabel("예정일", { exact: false }).fill("2026-09-08");
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    editor.getByText("대상 자산을 1개 이상 선택해 주세요.", { exact: true }),
  ).toBeVisible();
  await expect(editor.locator("#field-asset_ids")).toBeFocused();

  const search = editor.getByRole("textbox", { name: "대상 자산 후보 검색" });
  await search.fill(first.asset_tag);
  await editor
    .getByRole("checkbox", { name: new RegExp(first.asset_tag) })
    .check();
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(first.asset_tag) }),
  ).toBeFocused();
  await expect(editor.getByText("1개 선택", { exact: true })).toBeVisible();
  await expect(editor.getByText(/같은 고객사의 자산만/)).toBeVisible();
  await search.fill(otherAsset.asset_tag);
  await expect(
    editor.getByText("검색 조건에 맞는 자산이 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(otherAsset.asset_tag) }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(first.asset_tag) }),
  ).toBeChecked();
  await search.fill(second.asset_tag);
  await editor
    .getByRole("checkbox", { name: new RegExp(second.asset_tag) })
    .check();
  await search.fill("없는 자산 " + suffix);
  await expect(editor.getByText("2개 선택", { exact: true })).toBeVisible();
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(first.asset_tag) }),
  ).toBeChecked();
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(second.asset_tag) }),
  ).toBeChecked();
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/data/inspections") &&
      response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  const saved = await (await savedResponse).json();
  await expect(editor).not.toBeVisible();
  expect(saved.asset_ids).toEqual([first.id, second.id]);

  const exported = await page.request.get(
    "/api/export/inspections?" +
      new URLSearchParams({ format: "csv", q: saved.name }),
  );
  expect(exported.status()).toBe(200);
  const csv = await exported.text();
  expect(csv).toContain(first.asset_tag);
  expect(csv).toContain(second.asset_tag);

  await page.goto("/inspections/" + saved.id);
  await expect(
    page.locator(`.detail-grid a[href="/assets/${first.id}"]`),
  ).toContainText(first.asset_tag);
  await expect(
    page.locator(`.detail-grid a[href="/assets/${second.id}"]`),
  ).toContainText(second.asset_tag);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await expect(editor.getByText("2개 선택", { exact: true })).toBeVisible();
  await editor
    .getByRole("checkbox", { name: new RegExp(first.asset_tag) })
    .uncheck();
  await expect(
    editor.getByRole("textbox", { name: "대상 자산 후보 검색" }),
  ).toBeFocused();
  await editor
    .getByRole("checkbox", { name: new RegExp(second.asset_tag) })
    .uncheck();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(
    editor.getByText("대상 자산을 1개 이상 선택해 주세요.", { exact: true }),
  ).toBeVisible();
  await expect(editor.locator("#field-asset_ids")).toBeFocused();
  await editor
    .getByRole("textbox", { name: "대상 자산 후보 검색" })
    .fill(second.asset_tag);
  await editor
    .getByRole("checkbox", { name: new RegExp(second.asset_tag) })
    .check();
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const edited = await (
    await page.request.get("/api/data/inspections/" + saved.id)
  ).json();
  expect(edited.asset_ids).toEqual([second.id]);
  expect(edited.asset_id).toBe(second.id);
});

test("inspection registration from an asset starts with that asset selected", async ({
  page,
}) => {
  await login(page);
  const { suffix, first } = await fixture(page);
  await page.goto("/assets/" + first.id);
  await page
    .getByRole("button", { name: /점검·일정/ })
    .first()
    .click();
  await page.getByRole("button", { name: "점검 등록", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(first.asset_tag) }),
  ).toBeChecked();
  await expect(editor.getByText("1개 선택", { exact: true })).toBeVisible();
  await editor
    .getByLabel("점검명", { exact: false })
    .fill("자산에서 등록 " + suffix);
  await editor.getByLabel("예정일", { exact: false }).fill("2026-09-08");
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/data/inspections") &&
      response.request().method() === "POST",
  );
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  const saved = await (await savedResponse).json();
  await expect(editor).not.toBeVisible();
  expect(saved.asset_ids).toEqual([first.id]);
});

test("editing preserves selected assets beyond lookup and detail pagination limits", async ({
  page,
}) => {
  test.setTimeout(120000);
  await login(page);
  const { suffix, site, first, second } = await fixture(page);
  const assets = [first, second];
  for (let index = 2; index < 102; index += 5) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(5, 102 - index) }, (_, offset) =>
        create(page, "assets", {
          name: `추가 점검 서버 ${suffix} ${String(index + offset).padStart(3, "0")}`,
          asset_tag: `MANY-${suffix}-${index + offset}`,
          site_id: site.id,
          product: "Server",
        }),
      ),
    );
    assets.push(...batch);
  }
  const inspection = await create(page, "inspections", {
    name: "전체 대상 유지 " + suffix,
    planned_date: "2026-09-08",
    asset_ids: assets.map((asset) => asset.id),
  });
  await page.goto("/inspections/" + inspection.id);
  await expect(page.locator('.detail-grid a[href^="/assets/"]')).toHaveCount(
    102,
  );
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.getByText("102개 선택", { exact: true })).toBeVisible();
  const additional = await create(page, "assets", {
    name: "새 점검 대상 " + suffix,
    asset_tag: "ADDITIONAL-" + suffix,
    site_id: site.id,
    product: "Server",
  });
  await editor
    .getByRole("textbox", { name: "대상 자산 후보 검색" })
    .fill(additional.asset_tag);
  await expect(
    editor.getByRole("checkbox", { name: new RegExp(additional.asset_tag) }),
  ).toBeVisible();
  await editor
    .getByRole("checkbox", { name: new RegExp(additional.asset_tag) })
    .check();
  assets.push(additional);
  await editor
    .getByRole("textbox", { name: "대상 자산 후보 검색" })
    .fill("없는 자산 " + suffix);
  await expect(editor.getByRole("checkbox", { checked: true })).toHaveCount(
    103,
  );
  await editor
    .getByLabel("점검명", { exact: false })
    .fill("전체 대상 유지 수정 " + suffix);
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor).not.toBeVisible();
  const edited = await (
    await page.request.get("/api/data/inspections/" + inspection.id)
  ).json();
  expect(new Set(edited.asset_ids)).toEqual(
    new Set(assets.map((asset) => asset.id)),
  );
});
