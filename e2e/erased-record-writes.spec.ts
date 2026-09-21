import { test, expect, type Page } from "@playwright/test";
const headers = { Origin: process.env.APP_URL || "http://localhost:3000" };
async function post(page: Page, path: string, data: Record<string, unknown>) {
  const r = await page.request.post(path, { headers, data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
test("erasure prevents new entries and reports on completed inspections and resolved tickets", async ({
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
  const customer = await post(page, "/api/data/customers", {
    name: "Erasure regression " + crypto.randomUUID(),
  });
  const site = await post(page, "/api/data/sites", {
    name: "Synthetic site",
    customer_id: customer.id,
  });
  const asset = await post(page, "/api/data/assets", {
    name: "Synthetic asset",
    site_id: site.id,
    product: "Server",
  });
  const inspection = await post(page, "/api/data/inspections", {
    name: "Completed synthetic inspection",
    asset_ids: [asset.id],
    planned_date: "2026-09-21",
    status: "completed",
    result: "Synthetic observed result",
  });
  const ticket = await post(page, "/api/data/tickets", {
    name: "Resolved synthetic ticket",
    customer_id: customer.id,
    asset_ids: [asset.id],
    status: "resolved",
    resolution: "Synthetic resolution",
  });
  const policies = await (await page.request.get("/api/privacy")).json();
  const policy = policies.policies.find(
    (p: { resource_kind: string }) => p.resource_kind === "customers",
  );
  await post(page, "/api/privacy", {
    action: "policy",
    resource_kind: "customers",
    purpose: "Synthetic test retention",
    lawful_basis: "Synthetic test authorization",
    retention_days: 30,
    retention_start: "archived_at",
    exception_rule: "Synthetic test exception",
    version: policy.version,
  });
  const archived = await page.request.patch(
    "/api/data/customers/" + customer.id,
    {
      headers,
      data: {
        name: customer.name,
        status: "archived",
        version: customer.version,
      },
    },
  );
  expect(archived.ok(), await archived.text()).toBeTruthy();
  const preview = await post(page, "/api/privacy", {
    action: "preview",
    subject_kind: "customers",
    subject_id: customer.id,
    reason: "Synthetic erasure regression",
    lawful_basis: "Synthetic test authorization",
  });
  await post(page, "/api/privacy", {
    action: "execute",
    id: preview.id,
    confirm: "파기 실행",
  });
  for (const [kind, record] of [
    ["inspections", inspection],
    ["tickets", ticket],
  ] as const) {
    for (const [path, data] of [
      [
        "/api/entries",
        { body: "Must not persist", evidence_level: "observed" },
      ],
      [
        "/api/reports",
        { audience: "customer", issue_reason: "Must not produce a report" },
      ],
    ] as const) {
      const r = await page.request.post(path, {
        headers,
        data: { entity_kind: kind, entity_id: record.id, ...data },
      });
      expect(r.status(), await r.text()).toBe(410);
    }
    const details = await (
      await page.request.get("/api/details/" + kind + "/" + record.id)
    ).json();
    expect(details.record.privacy_erased_at).toBeTruthy();
  }
});
