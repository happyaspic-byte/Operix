import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Runs only against the disposable environment prepared by the CI workflow.
const base = process.env.APP_URL;
if (
  base !== "http://localhost:3000" ||
  process.env.OPERIX_CONTAINER_TEST !== "1"
)
  throw new Error("This verification requires the disposable CI environment.");
const mode = process.argv[2];
const fixturePath = "test-results/container-fixture.json";
const content =
  "Operix synthetic attachment: container and backup verification.";
let cookie;
async function call(path, init = {}) {
  const headers = {
    Origin: base,
    ...(cookie ? { Cookie: cookie } : {}),
    ...init.headers,
  };
  const response = await fetch(base + path, { ...init, headers });
  if (!response.ok)
    throw new Error(
      `${path}: HTTP ${response.status} ${await response.text()}`,
    );
  return response;
}
for (let attempt = 0; ; attempt++) {
  try {
    const response = await fetch(base + "/api/health");
    if (response.ok) break;
  } catch {}
  if (attempt >= 90) throw new Error("Container did not become healthy.");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
const login = await call("/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  }),
});
cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "Login must issue a session cookie");
async function create(kind, data) {
  return (
    await call("/api/data/" + kind, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  ).json();
}
if (mode === "prepare") {
  const customer = await create("customers", {
    name: "Container test customer",
  });
  const site = await create("sites", {
    customer_id: customer.id,
    name: "Container test site",
  });
  const asset = await create("assets", {
    site_id: site.id,
    name: "Persistent test asset",
    product: "Server",
  });
  const form = new FormData();
  form.set("entity_kind", "assets");
  form.set("entity_id", asset.id);
  form.set(
    "file",
    new File([content], "persistent-note.txt", { type: "text/plain" }),
  );
  const document = await (
    await call("/api/documents", { method: "POST", body: form })
  ).json();
  await mkdir("test-results", { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify({ asset_id: asset.id, document_id: document.id }),
  );
  console.log("Disposable DB and attachment fixture created.");
} else {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const asset = await (
    await call("/api/data/assets/" + fixture.asset_id)
  ).json();
  if (mode === "mutate") {
    await call("/api/data/assets/" + asset.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        site_id: asset.site_id,
        name: "Changed after backup",
        product: "Server",
        version: asset.version,
      }),
    });
    console.log(
      "Disposable asset changed after backup for restore verification.",
    );
  } else if (mode === "verify") {
    assert.equal(asset.name, "Persistent test asset");
    assert.equal(
      await (await call("/api/documents/" + fixture.document_id)).text(),
      content,
    );
    console.log("DB record and authenticated attachment bytes verified.");
  } else throw new Error("Expected prepare, mutate, or verify.");
}
