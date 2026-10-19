import { test, expect } from "@playwright/test";

test.use({ trace: "off" });

const origin = { Origin: process.env.APP_URL || "http://localhost:3000" };
const requestId = expect.stringMatching(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);

test("oversized login JSON is rejected before credentials are processed", async ({
  request,
}) => {
  const response = await request.post("/api/auth/login", {
    headers: origin,
    data: {
      email: "synthetic@example.test",
      password: "wrong",
      padding: "가".repeat(350000),
    },
  });
  expect(response.status()).toBe(413);
  expect(await response.json()).toEqual({
    error: "입력 데이터가 너무 큽니다.",
    request_id: requestId,
  });
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect((await request.get("/api/data/customers")).status()).toBe(401);
});

test("oversized mutation cannot write data while ordinary Korean JSON still works", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    headers: origin,
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
  const name = "보안 경계 검증 " + crypto.randomUUID();
  const blocked = await request.post("/api/data/customers", {
    headers: origin,
    data: { name, notes: "가".repeat(350000) },
  });
  expect(blocked.status()).toBe(413);
  expect(await blocked.json()).toEqual({
    error: "입력 데이터가 너무 큽니다.",
    request_id: requestId,
  });
  const search = "/api/data/customers?q=" + encodeURIComponent(name);
  const absent = await request.get(search);
  expect(absent.status()).toBe(200);
  expect((await absent.json()).total).toBe(0);
  const accepted = await request.post("/api/data/customers", {
    headers: origin,
    data: { name, notes: "정상 입력 😀" },
  });
  expect(accepted.status()).toBe(201);
  const saved = await accepted.json();
  expect(saved.notes).toBe("정상 입력 😀");
  const persisted = await request.get("/api/data/customers/" + saved.id);
  expect(persisted.status()).toBe(200);
  expect((await persisted.json()).name).toBe(name);
});

test("entity routes named after inherited object keys show the not-found page", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    headers: origin,
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
  // The status stays 200 because (erp)/loading.tsx streams the response before
  // notFound() runs, so assert on the rendered page instead.
  for (const path of [
    "/constructor",
    "/toString",
    "/constructor/00000000-0000-4000-8000-000000000000",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: "페이지를 찾을 수 없습니다." }),
      path,
    ).toBeVisible();
    await expect(
      page.getByText("정보를 불러오지 못했습니다."),
      path,
    ).toHaveCount(0);
  }
});

test("export kinds named after inherited object keys answer 404", async ({
  request,
}) => {
  const login = await request.post("/api/auth/login", {
    headers: origin,
    data: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  expect(login.status()).toBe(200);
  for (const kind of ["constructor", "toString", "__proto__"]) {
    const response = await request.get("/api/export/" + kind);
    expect(response.status(), kind).toBe(404);
    expect((await response.json()).error, kind).toBe(
      "자료 유형을 찾을 수 없습니다.",
    );
  }
});
