import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSupportedNodeVersion } from "../scripts/runtime-version.mjs";
test("only the supported Node 24 runtime is accepted", () => {
  for (const version of ["24.0.0", "24.19.0"])
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  for (const version of ["22.20.0", "25.0.0", "26.0.0", "invalid"])
    assert.throws(() => assertSupportedNodeVersion(version), /Node.js 24/);
});
