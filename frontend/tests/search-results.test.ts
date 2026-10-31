import assert from "node:assert/strict"
import test from "node:test"

import type { SearchResults } from "../src/entities/manifests/types.ts"
import { firstResultHref, groupSearchResults } from "../src/features/search-manifests/search-results.ts"

const empty: SearchResults = { query: "rev", objects: [], columns: [], knowledge: [], truncated: false }

test("search results are grouped, linked, and empty groups are dropped", () => {
  const groups = groupSearchResults({
    ...empty,
    columns: [
      {
        connectionId: "c1",
        connectionName: "Store",
        objectId: "o1",
        objectSchema: "shop",
        objectName: "orders",
        columnId: "col1",
        name: "total",
        label: "Order total",
        dataType: "numeric(12,2)",
        present: false,
        matched: "description",
        snippet: "Net revenue before refunds",
      },
    ],
    knowledge: [
      { entryId: "k1", title: "Net revenue", connection: null, matched: "title", snippet: "Sum of totals" },
    ],
  })
  assert.deepEqual(
    groups.map((group) => group.id),
    ["columns", "knowledge"],
  )
  assert.deepEqual(groups[0]?.items[0], {
    key: "column:col1",
    href: "/manifests/c1/objects/o1#column-col1",
    title: "shop.orders.total",
    context: "Store · numeric(12,2) · Order total",
    matched: "description",
    snippet: "Net revenue before refunds",
    removed: true,
  })
  assert.equal(groups[1]?.items[0]?.href, "/manifests/knowledge/k1")
  assert.equal(groups[1]?.items[0]?.context, "Not about one source")
  assert.equal(groups[1]?.items[0]?.matched, "term")
  assert.equal(firstResultHref(groups), "/manifests/c1/objects/o1#column-col1")
})

test("tables come first and nothing found means no first result", () => {
  const groups = groupSearchResults({
    ...empty,
    objects: [
      {
        connectionId: "c1",
        connectionName: "Store",
        objectId: "o2",
        schema: "shop",
        name: "orders",
        label: null,
        kind: "table",
        present: true,
        matched: "rowMeaning",
        snippet: null,
      },
    ],
  })
  assert.equal(groups[0]?.label, "Tables, views, and collections")
  assert.equal(groups[0]?.items[0]?.context, "Store")
  assert.equal(groups[0]?.items[0]?.matched, "row meaning")
  assert.equal(firstResultHref(groups), "/manifests/c1/objects/o2")
  assert.deepEqual(groupSearchResults(empty), [])
  assert.equal(firstResultHref([]), null)
})
