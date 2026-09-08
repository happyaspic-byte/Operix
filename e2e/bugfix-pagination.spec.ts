import { test, expect } from "@playwright/test";

// Login credentials must not be included in retained request traces.
test.use({ trace: "off" });

test("Authenticated listing rejects invalid pagination and preserves normal pages", async ({
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

  for (const query of [
    "limit=0",
    "limit=-1",
    "limit=",
    "limit=101",
    "limit=1.5",
    "page=0",
    "page=-1",
    "page=",
    "page=100001",
    "page=1.5&limit=1",
    "page=1.5&limit=20",
    "page=Infinity",
    "page=1e100",
    "page=9007199254740991&limit=100",
  ]) {
    const response = await request.get(`/api/data/customers?${query}`);
    expect(response.status(), query).toBe(400);
    expect((await response.json()).error).toEqual(expect.any(String));
  }

  const marker = `bugfix-pagination-${crypto.randomUUID()}`;
  const customers: { id: string; version: number; data: { name: string } }[] =
    [];
  try {
    for (const suffix of ["a", "b", "c"]) {
      const data = { name: `${marker}-${suffix}` };
      const response = await request.post("/api/data/customers", {
        headers,
        data,
      });
      expect(response.status(), `Create ${data.name}`).toBe(201);
      const saved = await response.json();
      customers.push({ id: saved.id, version: saved.version, data });
    }

    for (const [index, customer] of customers.entries()) {
      const page = index + 1;
      const query = new URLSearchParams({
        q: marker,
        sort: "name",
        direction: "asc",
        limit: "1",
        page: String(page),
      });
      const response = await request.get(`/api/data/customers?${query}`);
      expect(response.status(), `Page ${page}`).toBe(200);
      const listing = await response.json();
      expect(listing.rows).toHaveLength(1);
      expect(listing.rows[0].id).toBe(customer.id);
      expect(listing.total).toBe(3);
      expect(listing.page).toBe(page);
      expect(listing.limit).toBe(1);
    }
  } finally {
    for (const customer of customers.toReversed()) {
      const response = await request.patch(
        `/api/data/customers/${customer.id}`,
        {
          headers,
          data: {
            ...customer.data,
            version: customer.version,
            status: "archived",
          },
        },
      );
      expect.soft(response.status(), `Archive ${customer.id}`).toBe(200);
    }
  }
});
