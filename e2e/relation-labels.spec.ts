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

// The value cell of one labelled field on a detail page.
const field = (page: Page, label: string) =>
  page
    .locator(".detail-fields > div")
    .filter({
      has: page.locator("dt", { hasText: new RegExp("^" + label + "$") }),
    })
    .locator("dd");

async function open(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible();
}

test("detail pages show the names of related records", async ({ page }) => {
  await login(page);
  const suffix = crypto.randomUUID();
  const account = await (await page.request.get("/api/account")).json();
  const admin = account.user;

  const customerName = "라벨 고객 " + suffix;
  const siteName = "라벨 사업장 " + suffix;
  const assetName = "라벨 서버 " + suffix;
  const originalName = "라벨 원계약 " + suffix;
  const renewalName = "라벨 갱신계약 " + suffix;
  const customer = await create(page, "customers", { name: customerName });
  const site = await create(page, "sites", {
    name: siteName,
    customer_id: customer.id,
  });
  const asset = await create(page, "assets", {
    name: assetName,
    site_id: site.id,
    product: "Server",
    owner_id: admin.id,
  });
  const original = await create(page, "contracts", {
    name: originalName,
    customer_id: customer.id,
    kind: "maintenance",
    term: "unknown",
  });
  const renewal = await create(page, "contracts", {
    name: renewalName,
    customer_id: customer.id,
    kind: "maintenance",
    term: "unknown",
    predecessor_id: original.id,
    owner_id: admin.id,
  });
  const component = await create(page, "components", {
    name: "라벨 구성요소 " + suffix,
    asset_id: asset.id,
  });
  const vm = await create(page, "vms", {
    name: "라벨 VM " + suffix,
    asset_id: asset.id,
    vcpu: 2,
    memory_gb: 4,
    disk_gb: 40,
  });
  const ticket = await create(page, "tickets", {
    name: "라벨 작업 " + suffix,
    customer_id: customer.id,
    assignee_id: admin.id,
  });
  const contact = await create(page, "customer_contacts", {
    name: "라벨 담당자 " + suffix,
    customer_id: customer.id,
    site_id: site.id,
  });

  // contracts: the predecessor is named, and is not the customer
  await open(page, "/contracts/" + renewal.id, renewalName);
  const predecessor = field(page, "이전 계약");
  await expect(
    predecessor.getByRole("link", { name: originalName }),
  ).toHaveAttribute("href", "/contracts/" + original.id);
  await expect(predecessor).not.toContainText(customerName);
  await expect(
    field(page, "실제 사용 고객사").getByRole("link", { name: customerName }),
  ).toHaveAttribute("href", "/customers/" + customer.id);
  await expect(field(page, "내부 담당자")).toHaveText(admin.name);

  // a contract without a predecessor
  await open(page, "/contracts/" + original.id, originalName);
  await expect(field(page, "이전 계약")).toHaveText("미지정");

  // components and VMs: the asset is named, not shown as its id
  await open(page, "/components/" + component.id, "라벨 구성요소 " + suffix);
  await expect(
    field(page, "대상 자산").getByRole("link", { name: assetName }),
  ).toHaveAttribute("href", "/assets/" + asset.id);
  await open(page, "/vms/" + vm.id, "라벨 VM " + suffix);
  await expect(
    field(page, "대상 자산").getByRole("link", { name: assetName }),
  ).toHaveAttribute("href", "/assets/" + asset.id);

  // assets: site and owner
  await open(page, "/assets/" + asset.id, assetName);
  await expect(
    field(page, "사업장").getByRole("link", { name: siteName }),
  ).toHaveAttribute("href", "/sites/" + site.id);
  await expect(field(page, "내부 담당자")).toHaveText(admin.name);

  // tickets: customer and assignee
  await open(page, "/tickets/" + ticket.id, "라벨 작업 " + suffix);
  await expect(
    field(page, "고객사").getByRole("link", { name: customerName }),
  ).toHaveAttribute("href", "/customers/" + customer.id);
  await expect(field(page, "담당자")).toHaveText(admin.name);

  // sites and contacts: customer and site
  await open(page, "/sites/" + site.id, siteName);
  await expect(
    field(page, "고객사").getByRole("link", { name: customerName }),
  ).toHaveAttribute("href", "/customers/" + customer.id);
  await open(page, "/customer_contacts/" + contact.id, "라벨 담당자 " + suffix);
  await expect(
    field(page, "고객사").getByRole("link", { name: customerName }),
  ).toHaveAttribute("href", "/customers/" + customer.id);
  await expect(
    field(page, "사업장").getByRole("link", { name: siteName }),
  ).toHaveAttribute("href", "/sites/" + site.id);
});

test("a relation without its label shows the raw value, never an unrelated name", async ({
  page,
}) => {
  await login(page);
  const suffix = crypto.randomUUID();
  const customerName = "누락 고객 " + suffix;
  const renewalName = "누락 갱신계약 " + suffix;
  const customer = await create(page, "customers", { name: customerName });
  const original = await create(page, "contracts", {
    name: "누락 원계약 " + suffix,
    customer_id: customer.id,
    kind: "maintenance",
    term: "unknown",
  });
  const renewal = await create(page, "contracts", {
    name: renewalName,
    customer_id: customer.id,
    kind: "maintenance",
    term: "unknown",
    predecessor_id: original.id,
  });
  // Simulate a row whose predecessor label is missing from the response.
  await page.route(
    new RegExp("/api/details/contracts/" + renewal.id),
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      delete body.record.predecessor_name;
      await route.fulfill({ response, json: body });
    },
  );
  await open(page, "/contracts/" + renewal.id, renewalName);
  const predecessor = field(page, "이전 계약");
  // The raw value is shown, never the unrelated customer name.
  await expect(
    predecessor.getByRole("link", { name: original.id }),
  ).toHaveAttribute("href", "/contracts/" + original.id);
  await expect(predecessor).not.toContainText(customerName);
});
