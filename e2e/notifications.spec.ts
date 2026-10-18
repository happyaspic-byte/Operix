import { test, expect, type Page } from "@playwright/test";

const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };
const invalid = "입력 항목과 형식을 확인해 주세요.";
const malformed = "올바른 JSON 객체가 필요합니다.";
const notObject = "JSON 객체를 전달해 주세요.";
const uuids = (count: number) =>
  Array.from({ length: count }, () => crypto.randomUUID());

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

async function unreadNotifications(page: Page) {
  const response = await page.request.get("/api/notifications?read=unread");
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

// Overdue inspections and one scheduler run give the administrator notifications.
async function ensureUnread(page: Page, count = 1) {
  if ((await unreadNotifications(page)).total >= count) return;
  const suffix = crypto.randomUUID();
  const customer = await create(page, "customers", {
    name: "알림 확인 고객 " + suffix,
  });
  const site = await create(page, "sites", {
    name: "알림 확인 사업장 " + suffix,
    customer_id: customer.id,
  });
  const asset = await create(page, "assets", {
    name: "알림 확인 서버 " + suffix,
    site_id: site.id,
    product: "Server",
  });
  for (let i = 1; i <= count; i++)
    await create(page, "inspections", {
      name: `알림 확인 점검 ${i} ${suffix}`,
      asset_ids: [asset.id],
      planned_date: "2026-09-08",
    });
  const jobs = await page.request.post("/api/jobs", { headers: origin });
  expect(jobs.status(), await jobs.text()).toBe(200);
  expect((await unreadNotifications(page)).total).toBeGreaterThanOrEqual(count);
}

async function openPanel(page: Page) {
  await page.goto("/dashboard");
  const bell = page.getByRole("button", { name: "알림", exact: true });
  await expect(bell).toHaveClass(/has-unread/);
  await bell.click();
  const panel = page.locator(".notification-panel");
  await expect(panel.locator("a.unread").first()).toBeVisible();
  return { bell, panel };
}

test("모두 읽음 clears the unread indicator and unread_total", async ({
  page,
}) => {
  await login(page);
  await ensureUnread(page);
  const { bell, panel } = await openPanel(page);
  await panel.getByRole("button", { name: "모두 읽음", exact: true }).click();
  await expect(bell).not.toHaveClass(/has-unread/);
  await expect(panel.locator("a.unread")).toHaveCount(0);
  const list = await (await page.request.get("/api/notifications")).json();
  expect(list.unread_total).toBe(0);
  const byId = await page.request.patch("/api/notifications", {
    headers: origin,
    data: { ids: [list.rows[0].id] },
  });
  expect(byId.status(), await byId.text()).toBe(200);
});

test("모두 읽음 failure keeps the list and shows the error inside the panel", async ({
  page,
}) => {
  await login(page);
  await ensureUnread(page);
  const { bell, panel } = await openPanel(page);
  const unread = panel.locator("a.unread");
  const unreadCount = await unread.count();
  const markAll = panel.getByRole("button", { name: "모두 읽음", exact: true });
  const message = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  await page.route("**/api/notifications", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, json: { error: message } })
      : route.continue(),
  );
  await markAll.click();
  await expect(panel.getByRole("alert")).toHaveText(message);
  await expect(bell).toHaveClass(/has-unread/);
  await expect(unread).toHaveCount(unreadCount);
  // Closing the panel clears the error.
  await bell.click();
  await bell.click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await markAll.click();
  await expect(panel.getByRole("alert")).toHaveText(message);
  // A successful retry clears it too.
  await page.unroute("**/api/notifications");
  await markAll.click();
  await expect(bell).not.toHaveClass(/has-unread/);
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("PATCH marks the given ids, treats an empty body as all and rejects anything else", async ({
  page,
}) => {
  await login(page);
  await ensureUnread(page, 2);
  // A Buffer goes out untouched; Playwright would quote a malformed string.
  const patch = (body?: string) =>
    page.request.patch("/api/notifications", {
      headers: { ...origin, "Content-Type": "application/json" },
      data: body === undefined ? undefined : Buffer.from(body),
    });
  const before = await unreadNotifications(page);
  const [first] = before.rows;
  const byId = await patch(JSON.stringify({ ids: [first.id] }));
  expect(byId.status(), await byId.text()).toBe(200);
  const after = await unreadNotifications(page);
  expect(after.total).toBe(before.total - 1);
  expect(after.rows.map((n: { id: string }) => n.id)).not.toContain(first.id);
  const empty = await patch();
  expect(empty.status(), await empty.text()).toBe(200);
  expect((await unreadNotifications(page)).total).toBe(0);
  for (const body of ['{"all":true}', JSON.stringify({ ids: uuids(100) })]) {
    const accepted = await patch(body);
    expect(accepted.status(), await accepted.text()).toBe(200);
  }
  const rejected = [
    ["malformed JSON", "{", malformed],
    ["whitespace only", " ", malformed],
    ["JSON null", "null", notObject],
    ["JSON array", "[]", notObject],
    ["no keys", "{}", invalid],
    ["all false", '{"all":false}', invalid],
    ["no ids", '{"ids":[]}', invalid],
    ["bad id", '{"ids":["not-a-uuid"]}', invalid],
    ["101 ids", JSON.stringify({ ids: uuids(101) }), invalid],
    ["all and ids", JSON.stringify({ all: true, ids: uuids(1) }), invalid],
  ];
  for (const [label, body, error] of rejected) {
    const response = await patch(body);
    expect(response.status(), label).toBe(400);
    expect((await response.json()).error, label).toBe(error);
  }
});
