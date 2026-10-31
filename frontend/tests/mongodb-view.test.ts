import assert from "node:assert/strict"
import test from "node:test"

import { describeEndpoint } from "../src/entities/connections/engine.ts"
import type { Connection } from "../src/entities/connections/types.ts"
import type { MongoFieldDetails, RefreshCounts } from "../src/entities/manifests/types.ts"
import {
  describeSample,
  formatRowEstimate,
  formatShare,
  hasMixedTypes,
  presenceSummary,
  splitFieldPath,
} from "../src/features/browse-manifest/manifest-view.ts"
import { describeCounts, refreshProgress } from "../src/features/refresh-manifest/refresh-summary.ts"

const rating: MongoFieldDetails = {
  engine: "mongodb",
  sampleSize: 200,
  types: [
    { type: "int", documents: 184 },
    { type: "string", documents: 6 },
  ],
  missing: 10,
  arrayElementTypes: null,
  depth: 0,
}

test("presence lists every type seen and the missing share, never collapsing a mix", () => {
  assert.equal(presenceSummary(rating), "int 92%, string 3%, missing 5%")
  assert.equal(hasMixedTypes(rating), true)
  const nullable: MongoFieldDetails = {
    ...rating,
    types: [
      { type: "string", documents: 190 },
      { type: "null", documents: 10 },
    ],
    missing: 0,
  }
  assert.equal(presenceSummary(nullable), "string 95%, null 5%")
  assert.equal(hasMixedTypes(nullable), false)
})

test("shares never round a few documents away or a gap up to everything", () => {
  assert.equal(formatShare(1, 200), "<1%")
  assert.equal(formatShare(199, 200), ">99%")
  assert.equal(formatShare(200, 200), "100%")
  assert.equal(formatShare(0, 200), "0%")
  assert.equal(formatShare(0, 0), "0%")
})

test("nested paths split into a muted parent and the field's own name", () => {
  assert.deepEqual(splitFieldPath("cart.items.sku", 2), { parent: "cart.items.", leaf: "sku" })
  assert.deepEqual(splitFieldPath("total", 0), { parent: "", leaf: "total" })
})

test("collections describe their sample and count documents", () => {
  const sample = describeSample({
    engine: "mongodb",
    collectionType: "collection",
    capped: false,
    sampleSize: 200,
    sampleMethod: "random",
    sampleBytesLimited: false,
    fieldsTruncated: true,
    depthTruncated: false,
    sampleFailure: null,
  })
  assert.equal(sample.summary, "Fields inferred from a random sample of 200 documents.")
  assert.deepEqual(sample.notes, ["Only the first 500 fields are listed."])
  assert.equal(formatRowEstimate(1, { one: "document", many: "documents" }), "≈ 1 document")
})

test("refresh wording follows the engine", () => {
  const counts: RefreshCounts = {
    objects: 4,
    columns: 61,
    relationships: 0,
    objectsAdded: 4,
    objectsRemoved: 0,
    columnsAdded: 61,
    columnsRemoved: 0,
  }
  assert.equal(describeCounts(counts, "mongodb"), "4 collections and views · 61 fields")
  const progress = refreshProgress(
    {
      id: "f1",
      connectionId: "c1",
      status: "running",
      trigger: "manual",
      phase: "reading_columns",
      objectsDone: 1,
      objectsTotal: 4,
      counts: null,
      error: null,
      triggeredBy: null,
      createdAt: "2026-10-31T10:00:00.000Z",
      startedAt: "2026-10-31T10:00:01.000Z",
      finishedAt: null,
    },
    "mongodb",
  )
  assert.equal(progress.label, "Sampling documents")
  assert.equal(progress.detail, "1 of 4 collections and views")
})

test("endpoints never include credentials", () => {
  const base = {
    id: "c1",
    workspaceId: "w1",
    name: "x",
    hasPassword: true,
    schemas: ["events"],
    status: "connected" as const,
    lastTestedAt: null,
    lastError: null,
    createdAt: "2026-10-31T10:00:00.000Z",
    updatedAt: "2026-10-31T10:00:00.000Z",
    capabilities: {
      queryLanguage: "mongodb" as const,
      operations: ["find" as const, "aggregate" as const],
      readOnly: true as const,
      joins: true,
      aggregates: true,
      allowedStages: ["$match"],
      forbiddenStages: ["$out"],
      forbiddenOperators: ["$where"],
      summary: "Read-only find and aggregate",
    },
  }
  const uri: Connection = {
    ...base,
    engine: "mongodb",
    config: { mode: "uri", hosts: ["a.example.net:27017", "b.example.net:27017"], srv: false, database: "events" },
  }
  assert.equal(describeEndpoint(uri), "mongodb://a.example.net:27017,b.example.net:27017/events")
  const fields: Connection = {
    ...base,
    engine: "mongodb",
    config: { mode: "fields", host: "127.0.0.1", port: 27017, database: "events", username: null, authSource: null, tls: false },
  }
  assert.equal(describeEndpoint(fields), "127.0.0.1:27017/events")
})
