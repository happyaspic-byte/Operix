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
  form.set("classification", "internal");
  form.set(
    "file",
    new File([content], "persistent-note.txt", { type: "text/plain" }),
  );
  const document = await (
    await call("/api/documents", { method: "POST", body: form })
  ).json();
  assert.equal(
    document.scan_status,
    "clean",
    "Real ClamAV must scan the fixture",
  );
  const eicar = new FormData();
  eicar.set("entity_kind", "assets");
  eicar.set("entity_id", asset.id);
  eicar.set("classification", "internal");
  eicar.set(
    "file",
    new File(
      ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"],
      "antivirus-test.txt",
    ),
  );
  const infected = await (
    await call("/api/documents", { method: "POST", body: eicar })
  ).json();
  assert.equal(infected.scan_status, "infected");
  const blocked = await fetch(base + "/api/documents/" + infected.id, {
    headers: { Cookie: cookie },
  });
  assert.equal(blocked.status, 423);
  const privateCustomer = await create("customers", {
    name: "Synthetic privacy recovery fixture",
    contact_name: "Synthetic private contact",
    email: "erase@example.test",
  });
  const privateForm = new FormData();
  privateForm.set("entity_kind", "customers");
  privateForm.set("entity_id", privateCustomer.id);
  privateForm.set("classification", "internal");
  privateForm.set(
    "file",
    new File(
      ["Synthetic personal copy for recovery verification"],
      "private-copy.txt",
    ),
  );
  const privateDoc = await (
    await call("/api/documents", { method: "POST", body: privateForm })
  ).json();
  await mkdir("test-results", { recursive: true });
  await writeFile(
    fixturePath,
    JSON.stringify({
      asset_id: asset.id,
      document_id: document.id,
      privacy_customer_id: privateCustomer.id,
      privacy_document_id: privateDoc.id,
    }),
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
    const extraForm = new FormData();
    extraForm.set("entity_kind", "assets");
    extraForm.set("entity_id", asset.id);
    extraForm.set("classification", "internal");
    extraForm.set(
      "file",
      new File(["This file did not exist at backup time"], "post-backup.txt"),
    );
    const extra = await (
      await call("/api/documents", { method: "POST", body: extraForm })
    ).json();
    fixture.extra_document_id = extra.id;
    const privateCustomer = await (
      await call("/api/data/customers/" + fixture.privacy_customer_id)
    ).json();
    await call("/api/data/customers/" + privateCustomer.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: privateCustomer.name,
        contact_name: privateCustomer.contact_name,
        email: privateCustomer.email,
        status: "archived",
        version: privateCustomer.version,
      }),
    });
    const policies = await (await call("/api/privacy")).json(),
      p = policies.policies.find((p) => p.resource_kind === "customers");
    await call("/api/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "policy",
        resource_kind: "customers",
        purpose: "Synthetic privacy verification",
        lawful_basis: "Synthetic test request",
        retention_days: 30,
        retention_start: "archived_at",
        exception_rule: "Synthetic legal hold review",
        version: p.version,
      }),
    });
    const preview = await (
      await call("/api/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          subject_kind: "customers",
          subject_id: privateCustomer.id,
          reason: "Synthetic erasure after backup",
          lawful_basis: "Synthetic test request",
        }),
      })
    ).json();
    await call("/api/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "execute",
        id: preview.id,
        confirm: "파기 실행",
      }),
    });
    fixture.erased = true;
    await writeFile(fixturePath, JSON.stringify(fixture));
    console.log(
      "Disposable asset changed after backup for restore verification.",
    );
  } else if (mode === "verify") {
    assert.equal(asset.name, "Persistent test asset");
    assert.equal(
      await (await call("/api/documents/" + fixture.document_id)).text(),
      content,
    );
    if (fixture.extra_document_id) {
      const missing = await fetch(
        base + "/api/documents/" + fixture.extra_document_id,
        { headers: { Cookie: cookie } },
      );
      assert.equal(
        missing.status,
        404,
        "A post-backup attachment must not survive restore",
      );
    }
    if (fixture.erased) {
      const p = await (
        await call("/api/data/customers/" + fixture.privacy_customer_id)
      ).json();
      assert.equal(p.email, "");
      assert.ok(p.privacy_erased_at, "Restore must replay erasure tombstones");
      const missing = await fetch(
        base + "/api/documents/" + fixture.privacy_document_id,
        { headers: { Cookie: cookie } },
      );
      assert.equal(
        missing.status,
        410,
        "Erased attachment must stay unavailable",
      );
    }
    console.log("DB record and authenticated attachment bytes verified.");
  } else throw new Error("Expected prepare, mutate, or verify.");
}
