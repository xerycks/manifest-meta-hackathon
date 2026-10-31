import assert from "node:assert/strict"
import test from "node:test"

import { describeMatch } from "../../src/search/schemas.js"
import { likePattern } from "../../src/shared/postgres/like.js"
import { plainText, snippet } from "../../src/shared/text.js"

test("likePattern matches wildcards and backslashes literally", () => {
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%")
  assert.equal(likePattern("orders"), "%orders%")
})

test("plainText drops Markdown markers but keeps names and link text", () => {
  const markdown = [
    "# Net revenue",
    "",
    "Sum of `orders.total` for **paid** orders, see [the policy](https://example.com/p).",
    "",
    "- excludes order_items refunds",
    "1. first",
    "> quoted",
    "```sql",
    "select 1",
    "```",
  ].join("\n")
  assert.equal(
    plainText(markdown),
    "Net revenue Sum of orders.total for paid orders, see the policy. excludes order_items refunds first quoted select 1",
  )
})

test("snippet centres on the match and marks cuts", () => {
  const text = `${"a".repeat(100)} needle ${"b".repeat(100)}`
  const cut = snippet(text, "NEEDLE", 40)
  assert.ok(cut.startsWith("…") && cut.endsWith("…"))
  assert.ok(cut.includes("needle"))
  assert.ok(cut.length <= 42)
  assert.equal(snippet("short text", "zzz", 40), "short text")
  assert.equal(snippet(`${"x".repeat(50)}`, null, 10), `${"x".repeat(10)}…`)
  // A match near the end keeps a full-length window.
  assert.equal(snippet(`${"x".repeat(50)}end`, "end", 10), `…${"x".repeat(7)}end`)
})

test("describeMatch reports the first matching field and a useful snippet", () => {
  const byName = describeMatch(
    [
      ["name", "orders"],
      ["label", null],
      ["description", "One **row** per checkout."],
    ],
    "ORD",
    "One **row** per checkout.",
  )
  assert.deepEqual(byName, { matched: "name", snippet: "One row per checkout." })

  const byDescription = describeMatch(
    [
      ["name", "total"],
      ["description", "Net revenue before refunds"],
    ],
    "revenue",
    "Net revenue before refunds",
  )
  assert.deepEqual(byDescription, { matched: "description", snippet: "Net revenue before refunds" })

  assert.deepEqual(describeMatch([["title", "Churn"]], "churn", null), { matched: "title", snippet: null })
})
