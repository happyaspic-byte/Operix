import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, failure } from "../src/lib/http.ts";
import { AppError } from "../src/lib/policy.ts";

// No database is used: these tests exercise the actual HTTP body boundary.
const limit = 1024 * 1024;
function request(body: string) {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    body,
  });
}
const tooLarge = (error: unknown) =>
  error instanceof AppError && error.status === 413;

test("JSON rejects UTF-8 bodies over one MiB even below the character limit", async () => {
  const body = JSON.stringify({ name: "가".repeat(350000) });
  assert.ok(body.length < limit);
  assert.ok(Buffer.byteLength(body) > limit);
  await assert.rejects(() => readJson(request(body)), tooLarge);
});

test("JSON cancels oversized streams and preserves 413 when cancellation fails", async () => {
  for (const cancelFails of [false, true]) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          if (pulls <= 17) controller.enqueue(new Uint8Array(65536).fill(32));
          else {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
          if (cancelFails) throw new Error("synthetic cancellation failure");
        },
      },
      { highWaterMark: 0 },
    );
    const req = new Request("http://localhost/api/auth/login", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await assert.rejects(() => readJson(req), tooLarge);
    assert.equal(cancelled, true);
    assert.equal(pulls, 17);
    assert.equal(body.locked, false);
  }
});

test("JSON accepts the exact byte limit and rejects one byte more", async () => {
  const exact = JSON.stringify({ value: "x".repeat(limit - 12) });
  const oversized = JSON.stringify({ value: "x".repeat(limit - 11) });
  assert.equal(Buffer.byteLength(exact), limit);
  assert.equal(Buffer.byteLength(oversized), limit + 1);
  assert.equal((await readJson(request(exact))).value.length, limit - 12);
  await assert.rejects(() => readJson(request(oversized)), tooLarge);
});

test("JSON preserves Korean characters split between stream chunks", async () => {
  const bytes = new TextEncoder().encode('{"name":"가😀"}');
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length)
        controller.enqueue(bytes.slice(offset, ++offset));
      else controller.close();
    },
  });
  const req = new Request("http://localhost/api/data/customers", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.deepEqual(await readJson(req), { name: "가😀" });
  assert.equal(body.locked, false);
});

test("Malformed and missing JSON retain a safe 400 response", async () => {
  for (const req of [
    request('{"private":"synthetic"'),
    new Request("http://localhost", { method: "POST" }),
  ]) {
    await assert.rejects(() => readJson(req), asyncError);
  }
  function asyncError(error: unknown) {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 400);
    assert.ok(!error.message.includes("synthetic"));
    return true;
  }
});

test("Oversized JSON maps to a safe 413 HTTP response", async () => {
  const response = await readJson(
    request(JSON.stringify({ name: "가".repeat(350000) })),
  ).then(() => new Response(null, { status: 200 }), failure);
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.match(
    body.request_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(body, {
    error: "입력 데이터가 너무 큽니다.",
    request_id: body.request_id,
  });
});
