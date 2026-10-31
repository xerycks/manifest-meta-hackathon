import assert from "node:assert/strict"
import test from "node:test"

import { buildInstructions } from "../../src/agent/instructions.js"
import {
  formatSourceContext,
  type SourceContext,
  type SourceOutline,
} from "../../src/agent/source-context.js"
import { capabilitiesFor } from "../../src/connections/capabilities.js"
import type { Connection } from "../../src/connections/repository.js"
import type { ManifestOutlineEntry } from "../../src/manifests/schemas.js"

function source(id: string, name: string, engine: "postgres" | "mongodb", schemas: string[]): Connection {
  const base = {
    id,
    workspaceId: "w",
    name,
    hasPassword: true,
    schemas,
    status: "connected" as const,
    lastTestedAt: null,
    lastError: null,
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    capabilities: capabilitiesFor(engine),
  }
  return engine === "postgres"
    ? { ...base, engine, config: { host: "h", port: 5432, database: "d", username: "u", sslMode: "disable" } }
    : ({
        ...base,
        engine,
        config: {
          mode: "fields",
          host: "h",
          port: 27017,
          database: "d",
          username: null,
          authSource: "admin",
          tls: false,
        },
      } as Connection)
}

function objects(
  schema: string,
  count: number,
  kind: ManifestOutlineEntry["kind"] = "table",
): ManifestOutlineEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${schema}-${index}`,
    schema,
    name: `table_${String(index).padStart(3, "0")}`,
    kind,
    label: index === 0 ? "Orders" : null,
    rowMeaning: index === 0 ? "one row per checkout" : null,
    columnCount: 7,
  }))
}

test("the outline lists schemas and objects with their meaning, within each source's share of the budget", () => {
  const big: SourceOutline = {
    source: source("s1", "Demo store (synthetic)", "postgres", ["shop", "support"]),
    objects: [...objects("shop", 300), ...objects("support", 5)],
    more: false,
  }
  const small: SourceOutline = {
    source: source("s2", "Web analytics (synthetic)", "mongodb", ["manifest_demo"]),
    objects: objects("manifest_demo", 3, "collection"),
    more: false,
  }
  const context: SourceContext = {
    sources: [big, small],
    knowledge: [{ id: "k1", title: "Net revenue" }],
    moreKnowledge: true,
  }
  const text = formatSourceContext(context, 4_000)
  assert.ok(text.length < 4_000 + 1_500, "headers and knowledge are on top of the outline budget")
  assert.match(
    text,
    /### Demo store \(synthetic\)\n- id: s1\n- engine: PostgreSQL; status: connected\n- schemas: shop, support/,
  )
  assert.match(text, /- queries: Read-only PostgreSQL SQL/)
  assert.match(
    text,
    / {2}shop\n {4}- table_000 · “Orders” · one row per checkout · 7 columns\n {4}- table_001 · 7 columns/,
  )
  assert.match(text, /… \d+ more not listed here; use search_metadata or describe_object/)
  // The second source keeps its share even though the first one is large.
  assert.match(
    text,
    /### Web analytics \(synthetic\)[\s\S]*- databases: manifest_demo[\s\S]*database → collections[\s\S]*table_002 · 7 fields/,
  )
  assert.match(text, /## Knowledge base entries[\s\S]*- Net revenue \(id: k1\)\n- … more entries/)

  const roomy = formatSourceContext(context, 100_000)
  assert.ok(!roomy.includes("more not listed"))
  assert.match(roomy, / {2}support\n {4}- table_000/)
})

test("sources without a published manifest, a capped listing, and no sources at all say so", () => {
  const empty: SourceOutline = {
    source: source("s1", "New", "postgres", ["public"]),
    objects: [],
    more: false,
  }
  const capped: SourceOutline = {
    source: source("s2", "Huge", "postgres", ["x"]),
    objects: objects("x", 2),
    more: true,
  }
  const text = formatSourceContext({ sources: [empty, capped], knowledge: [], moreKnowledge: false })
  assert.match(text, /outline: nothing published yet/)
  assert.match(text, /… 0\+ more not listed here/)
  assert.ok(!text.includes("Knowledge base"))
  assert.match(
    formatSourceContext({ sources: [], knowledge: [], moreKnowledge: false }),
    /No sources are available/,
  )
})

test("instructions carry the workspace, the date, the rules, and the sources section", () => {
  const prompt = buildInstructions({
    workspace: { name: "Acme", description: "  Coffee retailer.  " },
    sources: "## Sources\n(sources here)",
    today: "2026-10-31",
  })
  assert.match(prompt, /workspace “Acme”/)
  assert.match(prompt, /About this workspace: Coffee retailer\.\n/)
  assert.match(prompt, /Today is 2026-10-31/)
  assert.match(prompt, /Look up meaning before querying/)
  assert.match(prompt, /never SQL, for MongoDB/)
  assert.match(prompt, /add a LIMIT/)
  assert.match(prompt, /Never invent values/)
  assert.match(prompt, /status "partial"/)
  assert.ok(prompt.endsWith("## Sources\n(sources here)"))
  assert.ok(
    !buildInstructions({ workspace: { name: "A", description: null }, sources: "", today: "x" }).includes(
      "About this workspace",
    ),
  )
})
