import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordTable } from "../src/components/record-table.tsx";
import { Badge } from "../src/components/ui.tsx";
import { labelFor } from "../src/lib/catalog.ts";

// Stored text can equal a key every object inherits.
const inherited = ["__proto__", "constructor", "toString", "hasOwnProperty"];

test("labelFor returns the label of an own key and nothing for an inherited one", () => {
  assert.equal(labelFor("completed"), "완료");
  // Added to the labels after the literal, as the contact roles are.
  assert.equal(labelFor("technical"), "기술 담당");
  for (const key of [...inherited, "valueOf", "no-such-status"])
    assert.equal(labelFor(key), undefined, key);
});

test("a stored value named like an Object.prototype key renders as itself", () => {
  for (const value of inherited) {
    const table = renderToStaticMarkup(
      createElement(RecordTable, {
        kind: "customers",
        rows: [{ id: "1", name: "Row", industry: value }],
      }),
    );
    assert.match(table, new RegExp(`<span class="">${value}</span>`), value);
    assert.match(
      renderToStaticMarkup(createElement(Badge, { value })),
      new RegExp(`</i>${value}</span>`),
      value,
    );
  }
});
