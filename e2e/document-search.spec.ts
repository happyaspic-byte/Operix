import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("Search filters survive direct URLs, refresh and browser history", async ({
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

  const customer = crypto.randomUUID();
  const uploader = crypto.randomUUID();
  const params = new URLSearchParams({
    tab: "documents",
    customer_id: customer,
    entity_kind: "inspections",
    classification: "internal",
    scan_status: "clean",
    from: "2026-01-02",
    to: "2026-01-03",
    uploader_id: uploader,
    q: "evidence",
  });
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/api/documents?") && r.request().method() === "GET",
  );
  await page.goto(`/documents?${params}`);
  const result = await response;
  expect(result.status()).toBe(200);
  const sent = new URL(result.url()).searchParams;
  for (const key of [
    "customer_id",
    "entity_kind",
    "classification",
    "scan_status",
    "from",
    "to",
    "uploader_id",
    "q",
  ])
    expect(sent.get(key), key).toBe(params.get(key));
  await expect(page.getByLabel("문서 검색")).toHaveValue("evidence");
  await expect(page.getByLabel("고객사 필터")).toHaveValue(customer);
  await expect(page.getByLabel("관련 기록 유형 필터")).toHaveValue(
    "inspections",
  );
  await expect(page.getByLabel("문서 분류 필터")).toHaveValue("internal");
  await expect(page.getByLabel("검사 상태 필터")).toHaveValue("clean");
  await expect(page.getByLabel("업로더 필터")).toHaveValue(uploader);
  await expect(page.getByLabel("시작일")).toHaveValue("2026-01-02");
  await expect(page.getByLabel("종료일")).toHaveValue("2026-01-03");

  await page.reload();
  await expect(page.getByLabel("문서 검색")).toHaveValue("evidence");
  await expect(page.getByLabel("검사 상태 필터")).toHaveValue("clean");
  await page.getByLabel("검사 상태 필터").selectOption("pending");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("scan_status"))
    .toBe("pending");
  await page.goBack();
  await expect(page.getByLabel("검사 상태 필터")).toHaveValue("clean");
  await page.goForward();
  await expect(page.getByLabel("검사 상태 필터")).toHaveValue("pending");
  await page.getByRole("button", { name: "확정 보고서" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("tab"))
    .toBe("reports");
  await expect(page.getByLabel("검사 상태 필터")).toHaveCount(0);
  await expect(page.getByLabel("문서 검색")).toHaveValue("evidence");
  await page.goBack();
  await expect(page.getByLabel("검사 상태 필터")).toHaveValue("pending");
});

test("Authenticated list endpoints preserve no-parameter behavior and reject malformed filters", async ({
  request,
}) => {
  const headers = { Origin: process.env.APP_URL || "http://localhost:3000" };
  const login = await request.post("/api/auth/login", {
    headers,
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
  for (const endpoint of ["documents", "reports"]) {
    const listing = await request.get(`/api/${endpoint}`);
    expect(listing.status(), endpoint).toBe(200);
    expect(await listing.json()).toEqual(
      expect.objectContaining({
        rows: expect.any(Array),
        total: expect.any(Number),
        page: 1,
      }),
    );
    for (const query of [
      "customer_id=invalid",
      "uploader_id=invalid",
      "entity_kind=invalid",
      "classification=invalid",
      "scan_status=invalid",
      "from=2026-02-30",
      "to=0000-01-01",
      "from=2026-02-02&to=2026-02-01",
    ]) {
      const response = await request.get(`/api/${endpoint}?${query}`);
      expect(response.status(), `${endpoint}?${query}`).toBe(400);
      expect((await response.json()).error).toEqual(expect.any(String));
    }
  }
});

test("Customer lookup, record type and classification filter real results", async ({
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
  const marker = `document-search-${crypto.randomUUID()}`;
  const customers: { id: string; version: number; name: string }[] = [];
  try {
    for (const suffix of ["selected", "other"]) {
      const name = `${marker}-${suffix}`;
      const response = await page.request.post("/api/data/customers", {
        headers,
        data: { name },
      });
      expect(response.status()).toBe(201);
      const saved = await response.json();
      customers.push({ id: saved.id, version: saved.version, name });
    }
    for (const [index, classification, suffix] of [
      [0, "internal", "match"],
      [0, "financial", "other-class"],
      [1, "internal", "other-customer"],
    ] as const) {
      const response = await page.request.post("/api/documents", {
        headers,
        multipart: {
          entity_kind: "customers",
          entity_id: customers[index].id,
          classification,
          file: {
            name: `${marker}-${suffix}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from("Synthetic search fixture"),
          },
        },
      });
      expect(response.status(), suffix).toBe(201);
    }

    await page.goto("/documents");
    await page.getByRole("button", { name: "첨부 자료" }).click();
    await page.getByLabel("문서 검색").fill(marker);
    await page.getByLabel("고객사 검색").fill(customers[0].name);
    const customerFilter = page.getByLabel("고객사 필터");
    await expect(
      customerFilter.locator(`option[value="${customers[0].id}"]`),
    ).toHaveText(customers[0].name);
    await customerFilter.selectOption(customers[0].id);
    await page.getByLabel("관련 기록 유형 필터").selectOption("customers");
    await page.getByLabel("문서 분류 필터").selectOption("internal");
    await expect
      .poll(() => {
        const params = new URL(page.url()).searchParams;
        return [
          params.get("customer_id"),
          params.get("entity_kind"),
          params.get("classification"),
          params.get("q"),
        ];
      })
      .toEqual([customers[0].id, "customers", "internal", marker]);
    await expect(
      page.getByRole("button", { name: `${marker}-match.txt` }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `${marker}-other-class.txt` }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `${marker}-other-customer.txt` }),
    ).toHaveCount(0);
  } finally {
    for (const customer of customers.toReversed()) {
      const response = await page.request.patch(
        `/api/data/customers/${customer.id}`,
        {
          headers,
          data: {
            name: customer.name,
            version: customer.version,
            status: "archived",
          },
        },
      );
      expect.soft(response.status(), `Archive ${customer.id}`).toBe(200);
    }
  }
});
