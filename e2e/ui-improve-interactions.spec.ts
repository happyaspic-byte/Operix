import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";

// Uses the dedicated seeded E2E server, never DATABASE_URL or a shared test DB.
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
  await expect(page.locator(".loading")).toHaveCount(0);
}

async function noOverflow(page: Page) {
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    .toBe(true);
}

async function axe(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).analyze();
  await mkdir("test-results/ui-improve/axe", { recursive: true });
  await writeFile(
    `test-results/ui-improve/axe/${label}.json`,
    JSON.stringify(result.violations, null, 2),
  );
  expect
    .soft(
      result.violations.filter((v) =>
        ["serious", "critical"].includes(v.impact || ""),
      ),
    )
    .toEqual([]);
}

test("capture representative screens at required viewports", async ({
  page,
}) => {
  test.setTimeout(180000);
  const phase = process.env.UI_CAPTURE_PHASE || "after";
  const dir = `test-results/ui-improve/${phase}`;
  await mkdir(dir, { recursive: true });
  for (const [width, height] of [
    [1440, 1000],
    [768, 1024],
    [390, 844],
  ]) {
    await page.context().clearCookies();
    await page.setViewportSize({ width, height });
    await page.goto("/login");
    await page.screenshot({
      path: `${dir}/login-${width}.png`,
      fullPage: true,
    });
    await login(page);
    for (const route of ["dashboard", "assets"]) {
      await page.goto("/" + route);
      await expect(page.locator(".loading")).toHaveCount(0);
      await page.screenshot({
        path: `${dir}/${route}-${width}.png`,
        fullPage: true,
      });
      if (phase === "after") {
        await noOverflow(page);
        await axe(page, `${route}-${width}`);
      }
    }
    await page.locator(".record-name").first().click();
    await expect(page.locator(".detail-fields")).toBeVisible();
    await page.screenshot({
      path: `${dir}/detail-${width}.png`,
      fullPage: true,
    });
    if (phase === "after") {
      await noOverflow(page);
      await axe(page, `detail-${width}`);
    }
    await page.getByRole("button", { name: "수정", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: `${dir}/editor-${width}.png`,
      fullPage: true,
    });
    if (phase === "after") {
      await noOverflow(page);
      await axe(page, `editor-${width}`);
    }
    await page.keyboard.press("Escape");
    await page.goto("/assets");
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await page.screenshot({
      path: `${dir}/import-${width}.png`,
      fullPage: true,
    });
    if (phase === "after") {
      await noOverflow(page);
      await axe(page, `import-${width}`);
    }
    await page.keyboard.press("Escape");
    // Real response shape, deliberately long synthetic text for layout stress only.
    await page.route("**/api/data/assets?*", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.rows = Array.from({ length: 20 }, (_, i) => ({
        ...data.rows[0],
        id: `ui-layout-${i}`,
        name: "가상 고객 현장 장비의 긴 한국어 이름 ".repeat(6),
        model: "MODEL_".repeat(35),
        asset_tag: "ASSET_".repeat(35),
        customer_name: "가상고객".repeat(25),
        site_name: "",
        observed_at: null,
      }));
      data.total = 41;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/assets");
    await expect(page.locator("tbody tr")).toHaveCount(20);
    await page.screenshot({
      path: `${dir}/long-values-${width}.png`,
      fullPage: true,
    });
    if (phase === "after") await noOverflow(page);
    await page.unroute("**/api/data/assets?*");
    await page
      .getByLabel("자산 검색", { exact: true })
      .fill("ui-no-such-record-982374");
    await expect(page.locator(".empty-state")).toBeVisible();
    await page.screenshot({
      path: `${dir}/empty-search-${width}.png`,
      fullPage: true,
    });
    await page.route("**/api/data/assets?*", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "가상 오류: 목록을 불러오지 못했습니다." },
      }),
    );
    await page.goto("/assets");
    await expect(page.locator(".error-notice[role=alert]")).toBeVisible();
    await page.screenshot({
      path: `${dir}/error-${width}.png`,
      fullPage: true,
    });
    await page.unroute("**/api/data/assets?*");
  }
});

test("failed list request stops loading and never presents stale results", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/data/assets?*", (route) =>
    route.fulfill({ status: 503, json: { error: "목록 요청 실패" } }),
  );
  await page.goto("/assets");
  await expect(page.locator(".error-notice[role=alert]")).toContainText(
    "목록 요청 실패",
  );
  await expect(page.locator(".loading")).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await page.unroute("**/api/data/assets?*");
  await page.getByLabel("자산 검색", { exact: true }).fill("ASRS");
  await expect(page.getByRole("table")).toBeVisible();
  await page.route("**/api/data/assets?*", (route) =>
    route.fulfill({ status: 503, json: { error: "목록 요청 실패" } }),
  );
  await page.getByLabel("자산 검색", { exact: true }).fill("different");
  await expect(page.locator(".error-notice[role=alert]")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("search empty state explains active filters and can clear them", async ({
  page,
}) => {
  await login(page);
  await page.goto("/assets");
  await page
    .getByLabel("자산 검색", { exact: true })
    .fill("ui-no-such-record-982374");
  await expect(
    page.getByText("검색 조건에 맞는 자료가 없습니다."),
  ).toBeVisible();
  const reset = page.getByRole("button", { name: "검색·필터 초기화" });
  await reset.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByLabel("자산 검색", { exact: true })).toHaveValue("");
});

test("editor is named, reports invalid fields and restores keyboard focus", async ({
  page,
}) => {
  await login(page);
  await page.goto("/customers");
  const trigger = page.getByRole("button", {
    name: "고객사 등록",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "고객사 등록", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByLabel("고객사명", { exact: false })).toBeFocused();
  await expect(dialog.locator(".field-error")).toBeVisible();
  await dialog
    .getByLabel("고객사명", { exact: false })
    .fill("키보드 검증 가상 고객");
  await expect(dialog.locator(".field-error")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.goto("/assets");
  const importer = page.getByRole("button", { name: "가져오기", exact: true });
  await importer.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "엑셀에서 자산 가져오기" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(importer).toBeFocused();
});

test("mobile navigation is keyboard-contained, dismissible and hidden when closed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const trigger = page.getByRole("button", { name: "메뉴 열기" });
  await trigger.focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".sidebar")),
  ).toBe(false);
  await trigger.focus();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest(".sidebar")),
  ).toBe(true);
  await axe(page, "mobile-navigation");
  await page.screenshot({
    path: "test-results/ui-improve/after/mobile-navigation.png",
  });
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest(".sidebar")),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("saving shows progress, preserves failed input and persists a corrected record", async ({
  page,
}) => {
  await login(page);
  await page.goto("/customers");
  await page.getByRole("button", { name: "고객사 등록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "고객사 등록", exact: true });
  const name = `UI 가상 고객 ${Date.now()}`;
  await dialog.getByLabel("고객사명", { exact: false }).fill(name);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/data/customers", async (route) => {
    await pending;
    await route.fulfill({ status: 503, json: { error: "가상 저장 실패" } });
  });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "저장 중…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog.getByRole("alert")).toContainText("가상 저장 실패");
  await expect(dialog.getByLabel("고객사명", { exact: false })).toHaveValue(
    name,
  );
  await page.unroute("**/api/data/customers");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "고객사 수정", exact: true });
  await edit.getByLabel("업종", { exact: true }).fill("UI 동작 검증");
  await edit.getByRole("button", { name: "저장", exact: true }).click();
  await expect(edit).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".detail-fields")).toContainText("UI 동작 검증");
});

test("200 percent zoom keeps filters, scrollable table and dialog controls usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await login(page);
  await page.goto("/assets");
  // Browser-equivalent reflow: 1440×1000 display at 200% exposes 720×500 CSS pixels.
  await page.setViewportSize({ width: 720, height: 500 });
  const browserSession = await page.context().newCDPSession(page);
  await browserSession.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 500,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await expect(page.getByRole("table")).toBeVisible();
  await noOverflow(page);
  const region = page.getByRole("region", { name: /자산 관리 표/ });
  await region.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => region.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.getByLabel("상태 필터").selectOption("normal");
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "자산 등록", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "자산 등록", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeInViewport();
  await dialog
    .getByLabel("메모", { exact: true })
    .fill("200% 확대에서 입력 확인");
  await expect(
    dialog.getByRole("button", { name: "저장", exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: "test-results/ui-improve/after/zoom-200-editor.png",
  });
  await page.keyboard.press("Escape");
  await noOverflow(page);
});

test("pending, genuinely empty and failed views remain distinct", async ({
  page,
}) => {
  await login(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/data/customers?*", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await pending;
    await route.fulfill({ response, json: { ...data, rows: [], total: 0 } });
  });
  await page.goto("/customers");
  await expect(page.locator(".loading[role=status]")).toBeVisible();
  await expect(page.locator(".empty-state")).toHaveCount(0);
  release();
  await expect(page.getByText("아직 등록된 정보가 없습니다.")).toBeVisible();
  await expect(page.locator(".loading")).toHaveCount(0);
  await page.unroute("**/api/data/customers?*");
  await page.goto("/assets");
  await page.locator(".record-name").first().click();
  await expect(page.locator(".detail-fields")).toBeVisible();
  const detail = page.url();
  for (const [url, api] of [
    ["/dashboard", "**/api/dashboard"],
    [detail, "**/api/details/assets/*"],
  ]) {
    await page.route(api, (route) =>
      route.fulfill({ status: 503, json: { error: "가상 화면 조회 실패" } }),
    );
    await page.goto(url);
    await expect(page.locator(".error-notice[role=alert]")).toContainText(
      "가상 화면 조회 실패",
    );
    await expect(page.locator(".loading")).toHaveCount(0);
    await page.unroute(api);
  }
});

test("saved filters and visible columns survive reload after empty results", async ({
  page,
}) => {
  await login(page);
  await page.goto("/assets");
  await page.getByLabel("자산 검색", { exact: true }).fill("ASRS");
  await page.getByLabel("상태 필터").selectOption("normal");
  await expect(
    page.getByText("검색 조건에 맞는 자료가 없습니다.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "현재 필터 저장", exact: true })
    .click();
  await page.reload();
  await page.getByLabel("저장한 필터", { exact: true }).selectOption("0");
  await expect(page.getByLabel("자산 검색", { exact: true })).toHaveValue(
    "ASRS",
  );
  await expect(page.getByLabel("상태 필터")).toHaveValue("normal");
  await page.getByLabel("상태 필터").selectOption("");
  await expect(page.getByRole("table")).toContainText("ASRS-DB");
  await page.locator("summary").filter({ hasText: "표시 열" }).click();
  await page.getByRole("checkbox", { name: "제품", exact: true }).uncheck();
  await page.locator("summary").filter({ hasText: "표시 열" }).click();
  await expect(
    page.getByRole("columnheader", { name: "제품", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "제품", exact: true }),
  ).toHaveCount(0);
});
