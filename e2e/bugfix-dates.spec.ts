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

  for (const path of [
    "/api/data/customers?from=0000-01-01",
    "/api/documents?from=0000-01-01",
    "/api/reports?to=0000-01-01",
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  }

  const marker = `bugfix-dates-${crypto.randomUUID()}`;
  const fixtures: {
    kind: "customers" | "sites" | "assets" | "contracts";
    id: string;
    version: number;
    data: Record<string, unknown>;
  }[] = [];
  async function createFixture(
    kind: (typeof fixtures)[number]["kind"],
    data: Record<string, unknown>,
  ) {
    const response = await request.post(`/api/data/${kind}`, { headers, data });
    expect(response.status(), `Create ${kind}`).toBe(201);
    const saved = await response.json();
    fixtures.push({ kind, id: saved.id, version: saved.version, data });
    return saved;
  }

  try {
    const customer = await createFixture("customers", {
      name: `${marker}-customer`,
    });
    const site = await createFixture("sites", {
      customer_id: customer.id,
      name: `${marker}-site`,
    });
    const asset = await createFixture("assets", {
      site_id: site.id,
      name: `${marker}-asset`,
      product: "Server",
    });
    const contract = {
      customer_id: customer.id,
      name: `${marker}-contract`,
      kind: "maintenance",
      term: "dated",
      end_date: "2028-02-29",
    };
    const cases = [
      ...["observed_at", "eol_date", "eos_date"].map((field) => ({
        kind: "assets",
        data: {
          site_id: site.id,
          name: `${marker}-invalid-${field}`,
          product: "Server",
          [field]: "0000-01-01",
        },
      })),
      {
        kind: "contracts",
        data: {
          ...contract,
          name: `${marker}-invalid-contract-start`,
          start_date: "0000-01-01",
        },
      },
      {
        kind: "contracts",
        data: {
          ...contract,
          name: `${marker}-invalid-contract-end`,
          end_date: "0000-02-29",
        },
      },
      {
        kind: "maintenance_plans",
        data: {
          asset_id: asset.id,
          name: `${marker}-invalid-plan-start`,
          interval_months: "1",
          start_date: "0000-01-01",
        },
      },
      {
        kind: "inspections",
        data: {
          asset_id: asset.id,
          name: `${marker}-invalid-inspection-planned`,
          planned_date: "0000-01-01",
        },
      },
    ];
    for (const { kind, data } of cases) {
      const response = await request.post(`/api/data/${kind}`, {
        headers,
        data,
      });
      expect(response.status(), data.name).toBe(400);
      expect((await response.json()).error).toContain("실제 날짜");
      const query = new URLSearchParams({ q: data.name });
      const listing = await request.get(`/api/data/${kind}?${query}`);
      expect(listing.status()).toBe(200);
      expect((await listing.json()).total).toBe(0);
    }

    const saved = await createFixture("contracts", {
      ...contract,
      start_date: "0001-01-01",
    });
    const retrieved = await request.get(`/api/data/contracts/${saved.id}`);
    expect(retrieved.status()).toBe(200);
    expect(await retrieved.json()).toMatchObject({
      id: saved.id,
      start_date: "0001-01-01",
      end_date: "2028-02-29",
    });
  } finally {
    for (const fixture of fixtures.toReversed()) {
      const response = await request.patch(
        `/api/data/${fixture.kind}/${fixture.id}`,
        {
          headers,
          data: {
            ...fixture.data,
            version: fixture.version,
            status: "archived",
          },
        },
      );
      expect
        .soft(response.status(), `Archive ${fixture.kind}/${fixture.id}`)
        .toBe(200);
    }
  }
});
