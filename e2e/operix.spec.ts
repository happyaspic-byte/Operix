import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.APP_URL || "http://localhost:3000";
const origin = { Origin: base };
const email = process.env.ADMIN_EMAIL!,
  password = process.env.ADMIN_PASSWORD!;
async function login(page: Page, account = email, pass = password) {
  await page.goto("/login");
  await page.getByLabel("이메일", { exact: true }).fill(account);
  await page.getByLabel("비밀번호", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await page.waitForURL("**/dashboard");
  await expect(
    page.getByRole("heading", { name: "오늘의 운영 현황" }),
  ).toBeVisible();
}
async function apiLogin(
  request: APIRequestContext,
  account = email,
  pass = password,
) {
  const r = await request.post("/api/auth/login", {
    headers: origin,
    data: { email: account, password: pass },
  });
  expect(r.status()).toBe(200);
}
const shotDir = process.env.SCREENSHOT_DIR || "test-results/screenshots";
test("desktop and mobile: pages render, navigation persists, screenshots", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mkdir(shotDir, { recursive: true });
  await page.goto("/login");
  await page.screenshot({
    path: shotDir + "/login.jpg",
    type: "jpeg",
    quality: 82,
  });
  await login(page);
  await page.screenshot({
    path: shotDir + "/dashboard-desktop.jpg",
    type: "jpeg",
    quality: 82,
  });
  await page.getByRole("link", { name: "자산 관리", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "자산 관리", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "자산 관리", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: shotDir + "/assets-desktop.jpg",
    type: "jpeg",
    quality: 82,
  });
  await page.goto("/dashboard");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await expect(
    page.getByRole("heading", { name: "오늘의 운영 현황" }),
  ).toBeVisible();
  await page.screenshot({
    path: shotDir + "/dashboard-mobile.jpg",
    type: "jpeg",
    quality: 82,
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "메뉴 열기" }).click();
  await page.getByRole("link", { name: "점검·일정", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "점검·일정", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("login rejects invalid credentials and limits repeated attempts", async ({
  page,
  request,
}) => {
  await page.goto("/login");
  await page
    .getByLabel("이메일", { exact: true })
    .fill("invalid-" + Date.now() + "@example.com");
  await page
    .getByLabel("비밀번호", { exact: true })
    .fill("invalid-password-123");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.locator(".error-notice")).toContainText(
    "올바르지 않습니다",
  );
  const target = "rate-" + Date.now() + "@example.com";
  for (let n = 0; n < 5; n++)
    expect(
      (
        await request.post("/api/auth/login", {
          headers: origin,
          data: { email: target, password: "wrong" },
        })
      ).status(),
    ).toBe(401);
  expect(
    (
      await request.post("/api/auth/login", {
        headers: origin,
        data: { email: target, password: "wrong" },
      })
    ).status(),
  ).toBe(429);
});
test("unauthenticated API and cross-origin mutations are rejected", async ({
  request,
}) => {
  expect((await request.get("/api/data/assets")).status()).toBe(401);
  await apiLogin(request);
  expect(
    (
      await request.post("/api/data/customers", {
        headers: { Origin: "https://untrusted.example" },
        data: { name: "blocked" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/data/customers", { data: { name: "blocked" } })
    ).status(),
  ).toBe(403);
});
test("role restrictions redact network and money, deny export and settings", async ({
  request,
}) => {
  await apiLogin(request, "viewer@operix.test", process.env.DEMO_PASSWORD);
  const assets = await (await request.get("/api/data/assets")).json();
  expect(assets.rows.length).toBeGreaterThan(0);
  expect(assets.rows[0]).not.toHaveProperty("management_ip");
  const contracts = await (await request.get("/api/data/contracts")).json();
  for (const c of contracts.rows) expect(c).not.toHaveProperty("amount");
  expect((await request.get("/api/export/assets")).status()).toBe(403);
  expect((await request.get("/api/settings")).status()).toBe(403);
  expect(
    (
      await request.post("/api/data/customers", {
        headers: origin,
        data: { name: "denied" },
      })
    ).status(),
  ).toBe(403);
});
test("customer → site → asset → contract → inspection → immutable report", async ({
  page,
}) => {
  await login(page);
  const suffix = Date.now().toString().slice(-7),
    customer = "E2E 고객 " + suffix,
    site = "E2E 사업장 " + suffix,
    asset = "E2E 자산 " + suffix;
  await page.goto("/customers");
  await page.getByRole("button", { name: "고객사 등록", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("고객사명", { exact: false })
    .fill(customer);
  await page
    .getByRole("dialog")
    .getByLabel("업종", { exact: true })
    .fill("검증");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: customer, exact: true }).click();
  await page
    .getByRole("button", { name: /사업장/ })
    .first()
    .click();
  await page.getByRole("button", { name: "사업장 등록", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("사업장명", { exact: false })
    .fill(site);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("link", { name: site, exact: true }).click();
  await page
    .getByRole("button", { name: /자산 관리/ })
    .first()
    .click();
  await page.getByRole("button", { name: "자산 등록", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("자산명", { exact: false })
    .fill(asset);
  await page
    .getByRole("dialog")
    .getByLabel("제조사 자산 ID")
    .fill("E2E-" + suffix);
  await page
    .getByRole("dialog")
    .getByLabel("제품", { exact: false })
    .selectOption("everRun");
  await page
    .getByRole("dialog")
    .getByLabel("모델", { exact: true })
    .fill("Test model");
  await page
    .getByRole("dialog")
    .getByLabel("보호 모드", { exact: true })
    .selectOption("FT");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("link", { name: asset + " Test model", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: asset, exact: true }),
  ).toBeVisible();
  const assetId = new URL(page.url()).pathname.split("/").pop()!;
  const lookup = await (await page.request.get("/api/lookups")).json();
  const c = lookup.customers.find((r: any) => r.name === customer);
  const contract = await page.request.post("/api/data/contracts", {
    headers: origin,
    data: {
      customer_id: c.id,
      name: "E2E 유지보수 " + suffix,
      kind: "maintenance",
      term: "dated",
      start_date: "2026-01-01",
      end_date: "2027-01-01",
      asset_ids: [assetId],
    },
  });
  expect(contract.status()).toBe(201);
  await page
    .getByRole("button", { name: /점검·일정/ })
    .first()
    .click();
  await page.getByRole("button", { name: "점검 등록", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("점검명", { exact: false })
    .fill("E2E 점검 " + suffix);
  await page
    .getByRole("dialog")
    .getByLabel("예정일", { exact: false })
    .fill("2026-09-05");
  await page
    .getByRole("dialog")
    .getByLabel("진행 상태", { exact: true })
    .selectOption("completed");
  await page
    .getByRole("dialog")
    .getByLabel("점검 결과", { exact: true })
    .fill("시스템과 이중화 상태를 확인했습니다. 가상 업무 검증 완료.");
  await page.getByRole("button", { name: "점검 항목 추가" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("점검 항목 1", { exact: true })
    .fill("시스템 상태 확인");
  await page
    .getByRole("checkbox", { name: "시스템 상태 확인 확인", exact: true })
    .check();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("link", { name: "E2E 점검 " + suffix, exact: true })
    .click();
  await expect(page).toHaveURL(/\/inspections\/[^/]+$/);
  const inspectionId = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("button", { name: "보고서 확정", exact: true }).click();
  await page
    .getByRole("button", { name: /문서·보고서/ })
    .first()
    .click();
  await expect(
    page.getByText("확정 보고서 · 버전 1", { exact: false }),
  ).toBeVisible();
  await page.getByRole("link", { name: /E2E 점검.*확정 보고서/ }).click();
  await expect(
    page.getByRole("heading", { name: "E2E 점검 " + suffix, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "시스템과 이중화 상태를 확인했습니다. 가상 업무 검증 완료.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: shotDir + "/report.jpg",
    type: "jpeg",
    quality: 82,
    fullPage: true,
  });
  await page.pdf({
    path: "test-results/sample-report.pdf",
    format: "A4",
    printBackground: true,
  });
  const original = await (
    await page.request.get("/api/data/inspections/" + inspectionId)
  ).json();
  const changed = await page.request.patch(
    "/api/data/inspections/" + inspectionId,
    {
      headers: origin,
      data: {
        asset_id: original.asset_id,
        name: original.name,
        planned_date: original.planned_date,
        assignee_id: original.assignee_id,
        status: "completed",
        checklist: original.checklist,
        result: "Changed after approval",
        version: original.version,
      },
    },
  );
  expect(changed.status(), await changed.text()).toBe(200);
  await page.reload();
  await expect(
    page.getByText(
      "시스템과 이중화 상태를 확인했습니다. 가상 업무 검증 완료.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Changed after approval", { exact: true }),
  ).toHaveCount(0);
});
test("search and list filters return real persisted results", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("전체 검색", { exact: true }).fill("ASRS");
  await expect(page.locator(".search-popover")).toContainText("ASRS-DB");
  await page.locator(".search-popover").getByRole("link").first().click();
  await expect(
    page.getByRole("heading", { name: "ASRS-DB", exact: true }),
  ).toBeVisible();
  await page.goto("/assets");
  await page.getByLabel("자산 검색", { exact: true }).fill("ASRS");
  await expect(page.getByRole("table")).toContainText("ASRS-DB");
  await page.getByLabel("상태 필터").selectOption("normal");
  await expect(
    page.getByText("아직 등록된 정보가 없습니다.", { exact: true }),
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
test("stale version returns conflict without overwriting persisted data", async ({
  request,
}) => {
  await apiLogin(request);
  const first = await (
    await request.post("/api/data/customers", {
      headers: origin,
      data: { name: "Concurrency " + Date.now() },
    })
  ).json();
  const update = {
    name: first.name,
    industry: "first",
    version: first.version,
  };
  expect(
    (
      await request.patch("/api/data/customers/" + first.id, {
        headers: origin,
        data: update,
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.patch("/api/data/customers/" + first.id, {
        headers: origin,
        data: { ...update, industry: "stale" },
      })
    ).status(),
  ).toBe(409);
  expect(
    (await (await request.get("/api/data/customers/" + first.id)).json())
      .industry,
  ).toBe("first");
});
test("uploads validate bytes, require authentication and preserve contents", async ({
  request,
  playwright,
}) => {
  await apiLogin(request);
  const assets = await (await request.get("/api/data/assets")).json();
  const id = assets.rows[0].id;
  const payload = Buffer.from("Operix synthetic support note.");
  const file = await request.post("/api/documents", {
    headers: origin,
    multipart: {
      entity_kind: "assets",
      entity_id: id,
      file: {
        name: "support-note.txt",
        mimeType: "text/plain",
        buffer: payload,
      },
    },
  });
  expect(file.status()).toBe(201);
  const doc = await file.json();
  const downloaded = await request.get("/api/documents/" + doc.id);
  expect(await downloaded.body()).toEqual(payload);
  const guest = await playwright.request.newContext({ baseURL: base });
  expect((await guest.get("/api/documents/" + doc.id)).status()).toBe(401);
  await guest.dispose();
  expect(
    (
      await request.post("/api/documents", {
        headers: origin,
        multipart: {
          entity_kind: "assets",
          entity_id: id,
          file: {
            name: "fake.png",
            mimeType: "image/png",
            buffer: Buffer.from("<script>bad</script>"),
          },
        },
      })
    ).status(),
  ).toBe(400);
});
test("XLSX export and CSV import validate, commit once and preserve records", async ({
  request,
}) => {
  await apiLogin(request);
  const lookups = await (await request.get("/api/lookups")).json(),
    site = lookups.sites[0];
  const csv = Buffer.from(
    "사업장 ID,자산명,자산 ID,제품,모델,소프트웨어 버전,보호 모드,확인 상태\n" +
      `${site.id},CSV 가져오기 검증,IMPORT-${Date.now()},Server,Demo,,unknown,unknown`,
  );
  const preview = await request.post("/api/import", {
    headers: origin,
    multipart: {
      file: { name: "import.csv", mimeType: "text/csv", buffer: csv },
    },
  });
  expect(preview.status()).toBe(200);
  const p = await preview.json();
  expect(p.valid).toBe(true);
  expect(
    (
      await request.patch("/api/import", {
        headers: origin,
        data: { batch_id: p.batch_id },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.patch("/api/import", {
        headers: origin,
        data: { batch_id: p.batch_id },
      })
    ).status(),
  ).toBe(409);
  const exp = await request.get("/api/export/assets");
  expect(exp.status()).toBe(200);
  expect((await exp.body()).subarray(0, 2).toString()).toBe("PK");
  const q = await (
    await request.get(
      "/api/data/assets?q=" + encodeURIComponent("CSV 가져오기 검증"),
    )
  ).json();
  expect(q.total).toBeGreaterThan(0);
});
test("logout invalidates session for direct API and page refresh", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await page.waitForURL("**/login");
  expect((await page.request.get("/api/data/assets")).status()).toBe(401);
  await page.goto("/assets");
  await expect(page).toHaveURL(/login/);
});
test("accessibility: no serious or critical automated findings on key pages", async ({
  page,
}) => {
  await login(page);
  const findings: any[] = [];
  for (const route of [
    "/dashboard",
    "/assets",
    "/contracts",
    "/inspections",
    "/tickets",
  ]) {
    await page.goto(route);
    await page.locator("h1").waitFor();
    await expect(page.locator(".loading")).toHaveCount(0);
    const result = await new AxeBuilder({ page }).analyze();
    findings.push(
      ...result.violations
        .filter((v) => ["serious", "critical"].includes(v.impact || ""))
        .map((v) => ({
          route,
          id: v.id,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
          description: v.description,
        })),
    );
  }
  await writeFile(
    "test-results/accessibility.json",
    JSON.stringify(findings, null, 2),
  );
  expect(findings).toEqual([]);
});
