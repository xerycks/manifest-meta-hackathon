import assert from "node:assert/strict"
import test from "node:test"

import {
  buildQuery,
  draftFromQuery,
  emptyQueryDraft,
  parseJsonObject,
  parsePipeline,
  queryPreview,
} from "../src/features/run-query/query-draft.ts"
import { describeOutcome, describeRunError } from "../src/entities/queries/run-outcome.ts"
import { ApiError } from "../src/shared/api/client.ts"

test("a SQL draft becomes a sql query with its row limit", () => {
  const draft = { ...emptyQueryDraft(["shop"]), sql: "SELECT 1", maxRows: "250" }
  assert.deepEqual(buildQuery(draft, "postgres"), { query: { language: "sql", sql: "SELECT 1" }, maxRows: 250 })
  assert.deepEqual(buildQuery({ ...draft, sql: "  " }, "postgres"), { errors: { sql: "Enter a SELECT statement." } })
  const tooMany = buildQuery({ ...draft, maxRows: "5001" }, "postgres")
  assert.ok("errors" in tooMany)
  assert.match(tooMany.errors.maxRows ?? "", /1 to 5,000/)
  assert.ok("errors" in buildQuery({ ...draft, maxRows: "2.5" }, "postgres"))
})

test("a MongoDB find draft parses its JSON fields and leaves blank ones out", () => {
  const draft = {
    ...emptyQueryDraft(["manifest_demo"]),
    collection: " sessions ",
    filter: '{"device": "mobile", "started_at": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}',
    sort: '{"started_at": -1}',
    skip: "10",
  }
  assert.deepEqual(buildQuery(draft, "mongodb"), {
    query: {
      language: "mongodb",
      database: "manifest_demo",
      collection: "sessions",
      operation: "find",
      filter: { device: "mobile", started_at: { $gte: { $date: "2026-01-01T00:00:00Z" } } },
      sort: { started_at: -1 },
      skip: 10,
    },
    maxRows: 1_000,
  })
})

test("invalid JSON and missing fields are reported per field, keeping the draft as typed", () => {
  const draft = {
    ...emptyQueryDraft(["manifest_demo"]),
    filter: "{device: mobile}",
    projection: "[1]",
    skip: "-1",
  }
  const built = buildQuery(draft, "mongodb")
  assert.ok("errors" in built)
  assert.equal(built.errors.collection, "Enter a collection.")
  assert.match(built.errors.filter ?? "", /^The filter is not valid JSON: /)
  assert.match(built.errors.projection ?? "", /must be a JSON object/)
  assert.match(built.errors.skip ?? "", /whole number/)
  assert.equal(draft.filter, "{device: mobile}")
})

test("an aggregate draft needs an array of stage objects", () => {
  const draft = {
    ...emptyQueryDraft(["manifest_demo"]),
    collection: "web_events",
    operation: "aggregate" as const,
    pipeline: '[{"$group": {"_id": "$type", "n": {"$sum": 1}}}]',
  }
  const built = buildQuery(draft, "mongodb")
  assert.ok("query" in built)
  assert.deepEqual(built.query, {
    language: "mongodb",
    database: "manifest_demo",
    collection: "web_events",
    operation: "aggregate",
    pipeline: [{ $group: { _id: "$type", n: { $sum: 1 } } }],
  })
  assert.ok("error" in parsePipeline('{"$match": {}}'))
  assert.ok("error" in parsePipeline("[1, 2]"))
  assert.deepEqual(parsePipeline(""), { value: [] })
  assert.deepEqual(parseJsonObject("  ", "The sort"), { value: undefined })
})

test("reopening a run restores its query and limit into the editor", () => {
  const current = { ...emptyQueryDraft(["manifest_demo"]), sql: "kept" }
  const restored = draftFromQuery(
    { language: "mongodb", database: "manifest_demo", collection: "sessions", operation: "find", filter: { a: 1 }, skip: 5 },
    50,
    current,
  )
  assert.equal(restored.collection, "sessions")
  assert.equal(restored.filter, '{\n  "a": 1\n}')
  assert.equal(restored.projection, "")
  assert.equal(restored.skip, "5")
  assert.equal(restored.maxRows, "50")
  assert.equal(restored.sql, "kept")
  assert.equal(draftFromQuery({ language: "sql", sql: "SELECT 2" }, 10, current).sql, "SELECT 2")
})

test("previews shorten queries to one line", () => {
  assert.equal(queryPreview({ language: "sql", sql: "SELECT  *\n  FROM orders" }), "SELECT * FROM orders")
  assert.equal(
    queryPreview({ language: "mongodb", database: "d", collection: "c", operation: "find" }),
    "c.find({})",
  )
  assert.equal(queryPreview({ language: "sql", sql: "x".repeat(200) }, 20).length, 20)
})

test("outcomes and request errors read as plain messages", () => {
  assert.equal(describeOutcome({ status: "succeeded", error: null }), null)
  assert.deepEqual(
    describeOutcome({
      status: "timed_out",
      error: { code: "QUERY_TIMEOUT", message: "The query ran longer than 30 seconds.", reason: null, name: null },
    }),
    { title: "Query timed out", message: "The query ran longer than 30 seconds." },
  )
  assert.equal(
    describeOutcome({
      status: "failed",
      error: { code: "SOURCE_CONNECTION_FAILED", message: "x", reason: "timeout", name: null },
    })?.title,
    "Could not reach the source",
  )
  const rejected = new ApiError(422, "QUERY_REJECTED", "$out writes data.", undefined, { reason: "stage_not_allowed" })
  assert.deepEqual(describeRunError(rejected), { title: "Query not allowed", message: "$out writes data." })
  const busy = new ApiError(429, "QUERY_BUSY", "Too many queries are running.")
  assert.equal(describeRunError(busy).title, "Too many queries running")
  const invalid = new ApiError(422, "VALIDATION_FAILED", "Invalid body", undefined, {
    issues: [{ path: "query.sql", message: "SQL can be at most 100000 characters" }],
  })
  assert.equal(describeRunError(invalid).message, "SQL can be at most 100000 characters")
})
