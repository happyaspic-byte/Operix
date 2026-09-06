import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

test("Date input rejects year zero without writes and preserves valid contract dates", async ({
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
  const lookupResponse = await request.get("/api/lookups");
  expect(lookupResponse.status()).toBe(200);
  const lookups = await lookupResponse.json();
  const marker = `bugfix-dates-${crypto.randomUUID()}`;
  const contract = {
    customer_id: lookups.customers[0].id,
    name: marker,
    kind: "maintenance",
    term: "dated",
    end_date: "2028-02-29",
  };
  const cases = [
    {
      kind: "assets",
      data: {
        site_id: lookups.sites[0].id,
        name: marker,
        product: "Server",
        observed_at: "0000-01-01",
      },
    },
    { kind: "contracts", data: { ...contract, start_date: "0000-01-01" } },
    { kind: "contracts", data: { ...contract, end_date: "0000-02-29" } },
    {
      kind: "maintenance_plans",
      data: {
        asset_id: lookups.assets[0].id,
        name: marker,
        interval_months: "1",
        start_date: "0000-01-01",
      },
    },
    {
      kind: "inspections",
      data: {
        asset_id: lookups.assets[0].id,
        name: marker,
        planned_date: "0000-01-01",
      },
    },
  ];
  for (const { kind, data } of cases) {
    const response = await request.post(`/api/data/${kind}`, { headers, data });
    expect(response.status(), kind).toBe(400);
    expect((await response.json()).error).toContain("실제 날짜");
    const listing = await request.get(`/api/data/${kind}?q=${marker}`);
    expect(listing.status()).toBe(200);
    expect((await listing.json()).total).toBe(0);
  }

  const created = await request.post("/api/data/contracts", {
    headers,
    data: { ...contract, start_date: "0001-01-01" },
  });
  expect(created.status()).toBe(201);
  const saved = await created.json();
  const retrieved = await request.get(`/api/data/contracts/${saved.id}`);
  expect(retrieved.status()).toBe(200);
  expect(await retrieved.json()).toMatchObject({
    id: saved.id,
    start_date: "0001-01-01",
    end_date: "2028-02-29",
  });
});
