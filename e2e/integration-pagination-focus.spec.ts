import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("Keyboard pagination retains focus while loading and removes stale rows on failure", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    headers: { Origin: process.env.APP_URL || "http://localhost:3000" },
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);

  const secondPage = Promise.withResolvers<void>();
  const thirdPage = Promise.withResolvers<void>();
  const requestedPages: number[] = [];
  await page.route("**/api/data/assets?*", async (route) => {
    const currentPage = Number(
      new URL(route.request().url()).searchParams.get("page"),
    );
    requestedPages.push(currentPage);
    if (currentPage === 2) await secondPage.promise;
    if (currentPage === 3) {
      await thirdPage.promise;
      await route.fulfill({
        status: 503,
        json: { error: "페이지 조회 실패 검증" },
      });
      return;
    }
    await route.fulfill({
      json: {
        rows: Array.from({ length: 20 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(currentPage * 100 + index).padStart(12, "0")}`,
          name: `Focus page ${currentPage} asset ${index + 1}`,
          asset_tag: `FOCUS-${currentPage}-${index + 1}`,
          product: "Server",
          model: "Synthetic pagination fixture",
          status: "normal",
          protection: "unknown",
          customer_name: "Pagination customer",
          site_name: "Pagination site",
          observed_at: "2026-09-08",
        })),
        total: 60,
        page: currentPage,
        limit: 20,
      },
    });
  });

  try {
    await page.goto("/assets");
    await expect(
      page.getByText("Focus page 1 asset 1", { exact: true }),
    ).toBeVisible();
    const next = page.getByRole("button", { name: "다음 페이지", exact: true });
    const previous = page.getByRole("button", {
      name: "이전 페이지",
      exact: true,
    });
    await expect(previous).toHaveAttribute("aria-disabled", "true");
    await expect(next).toHaveAttribute("aria-disabled", "false");
    await next.focus();
    await page.keyboard.press("Enter");

    await expect.poll(() => requestedPages).toEqual([1, 2]);
    await expect(page.getByRole("status")).toContainText("불러오는 중");
    await expect(next).toBeFocused();
    await expect(next).toHaveAttribute("aria-disabled", "true");
    await expect(previous).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("table")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await expect(next).toBeFocused();
    await expect(page).toHaveURL(/[?&]page=2(?:&|$)/);
    expect(requestedPages).toEqual([1, 2]);

    secondPage.resolve();
    await expect(
      page.getByText("Focus page 2 asset 1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(next).toBeFocused();
    await expect(next).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
    expect(requestedPages).toEqual([1, 2]);

    await page.keyboard.press("Enter");
    await expect.poll(() => requestedPages).toEqual([1, 2, 3]);
    await expect(next).toBeFocused();
    await expect(next).toHaveAttribute("aria-disabled", "true");
    thirdPage.resolve();
    await expect(page.getByRole("alert")).toHaveText("페이지 조회 실패 검증");
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(
      page.getByText("Focus page 2 asset 1", { exact: true }),
    ).toHaveCount(0);
  } finally {
    secondPage.resolve();
    thirdPage.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});
