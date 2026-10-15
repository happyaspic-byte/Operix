import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
const revision = "a".repeat(40);
test("deployment verification rejects unhealthy, stale and redirected services", async () => {
  for (const body of [
    { status: "degraded", revision },
    { status: "ok", revision: "b".repeat(40) },
  ])
    await assert.rejects(() =>
      verifyDeployment("https://operix.test", revision, {
        fetcher: async () => Response.json(body),
      }),
    );
  await assert.rejects(() => verifyDeployment("http://operix.test", revision));
  await assert.rejects(() =>
    verifyDeployment("https://user:password@operix.test", revision),
  );
  const calls: string[] = [];
  const result = await verifyDeployment("https://operix.test", revision, {
    fetcher: async (url, options) => {
      assert.equal(options?.redirect, "error");
      calls.push(String(url));
      return String(url).endsWith("/api/health")
        ? Response.json({ status: "ok", revision })
        : new Response("<html>로그인</html>", {
            headers: { "content-type": "text/html" },
          });
    },
  });
  assert.equal(result.revision, revision);
  assert.equal(result.login, "ok");
  assert.equal(calls.length, 2);
});
