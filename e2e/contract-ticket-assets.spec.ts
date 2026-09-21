import { test, expect, type Page } from "@playwright/test";
const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };
async function create(page: Page, kind: string, data: Record<string, unknown>) {
  const r = await page.request.post("/api/data/" + kind, {
    headers: origin,
    data,
  });
  expect(r.status(), await r.text()).toBe(201);
  return r.json();
}
test("contracts and tickets search beyond 100 assets and preserve scoped selections when editing", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.goto("/login");
  await page
    .getByLabel("이메일", { exact: true })
    .fill(process.env.ADMIN_EMAIL!);
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill(process.env.ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
  const suffix = crypto.randomUUID();
  const customer = await create(page, "customers", {
    name: "Asset scope " + suffix,
  });
  const other = await create(page, "customers", {
    name: "Other scope " + suffix,
  });
  const site = await create(page, "sites", {
    name: "Scope site",
    customer_id: customer.id,
  });
  for (let i = 0; i < 101; i += 5) {
    await Promise.all(
      Array.from({ length: Math.min(5, 101 - i) }, (_, j) =>
        create(page, "assets", {
          name: `AAA scope ${suffix} ${i + j}`,
          site_id: site.id,
          product: "Server",
        }),
      ),
    );
  }
  const target = await create(page, "assets", {
    name: "ZZZ scope " + suffix,
    asset_tag: "TARGET-" + suffix,
    site_id: site.id,
    product: "Server",
  });
  const firstPage = await (
    await page.request.get(
      "/api/lookups?entity=assets&customer_id=" + customer.id,
    )
  ).json();
  expect(firstPage.assets).toHaveLength(100);
  expect(firstPage.assets.map((a: { id: string }) => a.id)).not.toContain(
    target.id,
  );
  for (const kind of ["contracts", "tickets"]) {
    const record = await create(page, kind, {
      name: "Picker " + kind + " " + suffix,
      customer_id: customer.id,
      asset_ids: [],
      ...(kind === "contracts" ? { term: "perpetual" } : {}),
    });
    await page.goto("/" + kind + "/" + record.id);
    await page.getByRole("button", { name: "수정", exact: true }).click();
    const editor = page.getByRole("dialog");
    const search = editor.getByRole("textbox", { name: "대상 자산 후보 검색" });
    await search.fill(target.asset_tag);
    await editor
      .getByRole("checkbox", { name: new RegExp(target.asset_tag) })
      .check();
    await search.fill("no match " + suffix);
    await expect(
      editor.getByRole("checkbox", { name: new RegExp(target.asset_tag) }),
    ).toBeChecked();
    await editor.getByRole("button", { name: "저장", exact: true }).click();
    await expect(editor).not.toBeVisible();
    const saved = await (
      await page.request.get("/api/data/" + kind + "/" + record.id)
    ).json();
    expect(saved.asset_ids).toEqual([target.id]);
    await page.getByRole("button", { name: "수정", exact: true }).click();
    await expect(
      editor.getByRole("checkbox", { name: new RegExp(target.asset_tag) }),
    ).toBeChecked();
    // Hold an old customer's lookup until after the customer changes.
    let release!: () => void;
    let intercepted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    await page.route("**/api/lookups?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("q") === target.asset_tag) {
        const response = await route.fetch();
        intercepted();
        await held;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await search.fill(target.asset_tag);
    await seen;
    await editor
      .getByLabel(
        kind === "contracts"
          ? "실제 사용 고객사 후보 검색"
          : "고객사 후보 검색",
        { exact: true },
      )
      .fill(other.name);
    await editor.locator("#field-customer_id").selectOption(other.id);
    release();
    await expect(editor.getByText("0개 선택", { exact: true })).toBeVisible();
    await expect(
      editor.getByRole("checkbox", { name: new RegExp(target.asset_tag) }),
    ).toHaveCount(0);
    await page.unrouteAll({ behavior: "wait" });
    page.once("dialog", (dialog) => dialog.accept());
    await editor.getByRole("button", { name: "취소", exact: true }).click();
    // Editing existing selections must also hydrate archived assets.
    if (kind === "tickets") {
      const current = await (
        await page.request.get("/api/data/assets/" + target.id)
      ).json();
      const archived = await page.request.patch(
        "/api/data/assets/" + target.id,
        {
          headers: origin,
          data: {
            name: current.name,
            site_id: current.site_id,
            product: current.product,
            asset_tag: current.asset_tag,
            status: "archived",
            version: current.version,
          },
        },
      );
      expect(archived.status(), await archived.text()).toBe(200);
      await page.getByRole("button", { name: "수정", exact: true }).click();
      await expect(
        editor.getByRole("checkbox", { name: new RegExp(target.asset_tag) }),
      ).toBeChecked();
      await expect(editor.getByText("보관·비활성 · 기존 연결")).toBeVisible();
      await editor.getByRole("button", { name: "저장", exact: true }).click();
      await expect(editor).not.toBeVisible();
    }
  }
});
