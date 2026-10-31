import assert from "node:assert/strict"
import test from "node:test"

import { Int32, Long, ObjectId } from "mongodb"

import { validateMongoQuery } from "../../src/queries/mongodb-validator.js"
import { mongoQuerySchema, type MongoQuery, type RejectionReason } from "../../src/queries/schemas.js"

const DATABASES = ["shop", "events"]

const find = (extra: Partial<MongoQuery> = {}): MongoQuery => ({
  language: "mongodb",
  database: "shop",
  collection: "orders",
  operation: "find",
  ...extra,
})

const aggregate = (pipeline: Record<string, unknown>[], extra: Partial<MongoQuery> = {}): MongoQuery => ({
  language: "mongodb",
  database: "shop",
  collection: "orders",
  operation: "aggregate",
  pipeline,
  ...extra,
})

function accepted(query: MongoQuery) {
  const outcome = validateMongoQuery(query, DATABASES)
  assert.ok("query" in outcome, "rejection" in outcome ? outcome.rejection.message : "")
  return outcome.query
}

const allowed: [string, MongoQuery][] = [
  ["a find with a filter, projection, sort, and skip", find({
    filter: { status: "paid", total: { $gte: 10 } },
    projection: { status: 1 },
    sort: { placed_at: -1 },
    skip: 5,
  })],
  ["$expr with ordinary operators", find({ filter: { $expr: { $gt: ["$total", "$discount"] } } })],
  ["a grouped aggregate", aggregate([
    { $match: { status: "paid" } },
    { $group: { _id: "$customer_id", revenue: { $sum: "$total" } } },
    { $sort: { revenue: -1 } },
  ])],
  ["$lookup with localField and with a sub-pipeline", aggregate([
    { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "customer" } },
    { $lookup: { from: "items", let: { id: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$order_id", "$$id"] } } }], as: "items" } },
  ])],
  ["$unionWith by name and with a pipeline", aggregate([
    { $unionWith: "archived_orders" },
    { $unionWith: { coll: "returns", pipeline: [{ $project: { _id: 1 } }] } },
  ])],
  ["$facet with allowed sub-pipelines", aggregate([
    { $facet: { byStatus: [{ $sortByCount: "$status" }], total: [{ $count: "n" }] } },
  ])],
  ["$graphLookup in the same database", aggregate([
    { $graphLookup: { from: "customers", startWith: "$referred_by", connectFromField: "referred_by", connectToField: "_id", as: "chain" } },
  ])],
]

for (const [label, query] of allowed) {
  test(`allows ${label}`, () => {
    accepted(query)
  })
}

const rejected: [string, MongoQuery, RejectionReason, string | null][] = [
  ["a database that is not selected", find({ database: "billing" }), "database_not_allowed", "billing"],
  ["the admin database", find({ database: "admin" }), "database_not_allowed", "admin"],
  ["a system collection", find({ collection: "system.profile" }), "collection_not_allowed", "system.profile"],
  ["$where in a find filter", find({ filter: { $where: "this.total > 10" } }), "operator_not_allowed", "$where"],
  ["$where inside $or", find({ filter: { $or: [{ status: "paid" }, { $where: "true" }] } }), "operator_not_allowed", "$where"],
  ["$function inside $expr", find({
    filter: { $expr: { $function: { body: "function () { return true }", args: [], lang: "js" } } },
  }), "operator_not_allowed", "$function"],
  ["$accumulator in a $group", aggregate([
    { $group: { _id: null, x: { $accumulator: { init: "function () {}", lang: "js" } } } },
  ]), "operator_not_allowed", "$accumulator"],
  ["$out", aggregate([{ $match: {} }, { $out: "copy" }]), "stage_not_allowed", "$out"],
  ["$merge", aggregate([{ $merge: { into: "copy" } }]), "stage_not_allowed", "$merge"],
  ["$out nested in a $facet", aggregate([{ $facet: { a: [{ $match: {} }, { $out: "copy" }] } }]), "stage_not_allowed", "$out"],
  ["$merge in a $lookup pipeline", aggregate([
    { $lookup: { from: "customers", pipeline: [{ $merge: "copy" }], as: "c" } },
  ]), "stage_not_allowed", "$merge"],
  ["$currentOp", aggregate([{ $currentOp: {} }]), "stage_not_allowed", "$currentOp"],
  ["$documents in a $unionWith", aggregate([{ $unionWith: { pipeline: [{ $documents: [{ a: 1 }] }] } }]), "stage_not_allowed", "$documents"],
  ["a stage outside the allowlist", aggregate([{ $search: { text: { query: "x" } } }]), "stage_not_allowed", "$search"],
  ["a $lookup to another database", aggregate([
    { $lookup: { from: { db: "billing", coll: "invoices" }, localField: "id", foreignField: "order_id", as: "i" } },
  ]), "cross_database", "billing.invoices"],
  ["a $unionWith to another database", aggregate([{ $unionWith: { db: "billing", coll: "invoices" } }]), "cross_database", "billing.invoices"],
  ["a $lookup to a system collection", aggregate([
    { $lookup: { from: "system.views", localField: "a", foreignField: "b", as: "v" } },
  ]), "collection_not_allowed", "system.views"],
  ["a stage with two names", aggregate([{ $match: {}, $sort: { a: 1 } }]), "invalid_query", null],
  ["invalid Extended JSON", find({ filter: { _id: { $oid: "not-an-object-id" } } }), "invalid_query", null],
]

for (const [label, query, reason, name] of rejected) {
  test(`rejects ${label}`, () => {
    const outcome = validateMongoQuery(query, DATABASES)
    assert.ok("rejection" in outcome, "rejected")
    assert.equal(outcome.rejection.reason, reason)
    assert.equal(outcome.rejection.name, name)
  })
}

test("relaxed Extended JSON values become BSON values, and numbers keep exact types", () => {
  const query = accepted(find({
    filter: {
      _id: { $oid: "64b7f0c2a1b2c3d4e5f60718" },
      placed_at: { $gte: { $date: "2026-01-01T00:00:00Z" } },
      big: { $numberLong: "9007199254740993" },
      qty: 3,
    },
  }))
  assert.equal(query.operation, "find")
  if (query.operation !== "find") return
  assert.ok(query.filter._id instanceof ObjectId)
  assert.equal((query.filter._id as ObjectId).toHexString(), "64b7f0c2a1b2c3d4e5f60718")
  const range = query.filter.placed_at as { $gte: Date }
  assert.ok(range.$gte instanceof Date)
  assert.equal(range.$gte.toISOString(), "2026-01-01T00:00:00.000Z")
  assert.ok(query.filter.big instanceof Long)
  assert.equal(String(query.filter.big), "9007199254740993")
  assert.ok(query.filter.qty instanceof Int32)
})

test("rejections explain themselves", () => {
  const out = validateMongoQuery(aggregate([{ $out: "copy" }]), DATABASES)
  assert.ok("rejection" in out)
  assert.match(out.rejection.message, /writes data or reads the server's state/)
  const lookup = validateMongoQuery(
    aggregate([{ $lookup: { from: { db: "billing", coll: "invoices" }, as: "i" } }]),
    DATABASES,
  )
  assert.ok("rejection" in lookup)
  assert.match(lookup.rejection.message, /same database \(shop\)/)
})

test("deeply nested queries are refused before they are walked", () => {
  let filter: Record<string, unknown> = { a: 1 }
  for (let depth = 0; depth < 60; depth += 1) filter = { $and: [filter] }
  const outcome = validateMongoQuery(find({ filter }), DATABASES)
  assert.ok("rejection" in outcome)
  assert.equal(outcome.rejection.reason, "invalid_query")
})

test("the request schema keeps find options and pipelines apart", () => {
  assert.equal(mongoQuerySchema.safeParse(find({ pipeline: [] })).success, false)
  assert.equal(mongoQuerySchema.safeParse(aggregate([], { filter: {} })).success, false)
  assert.equal(mongoQuerySchema.safeParse({ ...find(), filter: [1] }).success, false)
  assert.equal(mongoQuerySchema.safeParse(aggregate([{ $match: {} }])).success, true)
})
