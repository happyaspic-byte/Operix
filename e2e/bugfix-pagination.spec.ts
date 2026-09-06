import { test, expect } from "@playwright/test";

// Login credentials must not be included in retained request traces.
test.use({ trace: "off" });

test("Authenticated listing rejects invalid pagination and preserves normal pages", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    headers: { Origin: process.env.APP_URL || "http://localhost:3000" },
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);

  for (const query of [
    "limit=1.5",
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

  const first = await request.get(
    "/api/data/customers?sort=name&direction=asc&limit=1&page=1",
  );
  const second = await request.get(
    "/api/data/customers?sort=name&direction=asc&limit=1&page=2",
  );
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  const a = await first.json();
  const b = await second.json();
  expect(a.rows).toHaveLength(1);
  expect(b.rows).toHaveLength(1);
  expect(a.rows[0].id).not.toBe(b.rows[0].id);
  expect(a.total).toBeGreaterThan(1);
  expect(b.total).toBe(a.total);
  expect(a.page).toBe(1);
  expect(b.page).toBe(2);
  expect(a.limit).toBe(1);
  expect(b.limit).toBe(1);
});
