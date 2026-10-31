import assert from "node:assert/strict"
import test from "node:test"

import { BSON, Decimal128, Double, Int32, Long, ObjectId } from "mongodb"

import {
  bsonTypeOf,
  FIELD_LIMITS,
  FieldProfiler,
  formatFieldType,
} from "../../src/connections/adapters/mongodb-sampling.js"
import type { DiscoveredColumn } from "../../src/connections/adapters/types.js"

/** Documents as the driver returns them while sampling (promoteValues: false). */
function asSampled(document: BSON.Document): BSON.Document {
  return BSON.deserialize(BSON.serialize(document), {
    promoteValues: false,
    promoteLongs: false,
    bsonRegExp: true,
  })
}

function profile(documents: BSON.Document[]): { profiler: FieldProfiler; fields: Map<string, DiscoveredColumn> } {
  const profiler = new FieldProfiler()
  for (const document of documents) profiler.add(asSampled(document))
  return { profiler, fields: new Map(profiler.fields().map((field) => [field.name, field])) }
}

test("BSON values are named like MongoDB's $type", () => {
  const sampled = asSampled({
    i: new Int32(1),
    d: new Double(2),
    l: Long.fromNumber(3),
    dec: Decimal128.fromString("1.10"),
    id: new ObjectId(),
    s: "x",
    b: true,
    n: null,
    at: new Date(),
    list: [],
    doc: {},
  })
  assert.deepEqual(
    Object.fromEntries(Object.entries(sampled).map(([key, value]) => [key, bsonTypeOf(value)])),
    {
      i: "int",
      d: "double",
      l: "long",
      dec: "decimal",
      id: "objectId",
      s: "string",
      b: "bool",
      n: "null",
      at: "date",
      list: "array",
      doc: "object",
    },
  )
})

test("nested documents and arrays become dotted paths in document order", () => {
  const { fields } = profile([
    {
      _id: 1,
      customer: { name: "Ava", address: { city: "Lisbon" } },
      items: [{ sku: "A", qty: 2 }, { sku: "B", qty: 1 }],
      tags: ["new", "gift"],
      total: 12.5,
    },
    { _id: 2, customer: { name: "Kai" }, items: [], tags: [], total: 3 },
  ])
  assert.deepEqual(
    [...fields.keys()],
    [
      "_id",
      "customer",
      "customer.name",
      "customer.address",
      "customer.address.city",
      "items",
      "items.sku",
      "items.qty",
      "tags",
      "total",
    ],
  )
  assert.equal(fields.get("_id")?.isPrimaryKey, true)
  assert.equal(fields.get("customer.address.city")?.details?.depth, 2)
  assert.equal(fields.get("items")?.dataType, "array<object>")
  assert.equal(fields.get("tags")?.dataType, "array<string>")
  // An empty array still counts as an array; its elements only count where there are some.
  assert.deepEqual(fields.get("items")?.details?.arrayElementTypes, [{ type: "object", documents: 1 }])
  // A path inside an array counts each document once, however many elements it has.
  assert.deepEqual(fields.get("items.sku")?.details?.types, [{ type: "string", documents: 1 }])
  assert.equal(fields.get("items.sku")?.details?.missing, 1)
  assert.equal(fields.get("total")?.dataType, "double | int")
})

test("mixed and missing types are reported per document, never collapsed", () => {
  const { fields } = profile([
    { rating: 5 },
    { rating: 4 },
    { rating: "3" },
    { rating: null },
    {},
  ])
  const rating = fields.get("rating")
  assert.equal(rating?.dataType, "int | null | string")
  assert.equal(rating?.nullable, true)
  assert.deepEqual(rating?.details, {
    engine: "mongodb",
    sampleSize: 5,
    types: [
      { type: "int", documents: 2 },
      { type: "null", documents: 1 },
      { type: "string", documents: 1 },
    ],
    missing: 1,
    arrayElementTypes: null,
    depth: 0,
  })

  const always = profile([{ code: "a" }, { code: "b" }]).fields.get("code")
  assert.equal(always?.nullable, false)
  assert.equal(always?.details?.missing, 0)
})

test("depth, field count, and path length are bounded", () => {
  let deep: BSON.Document = { leaf: 1 }
  for (let level = 0; level < 10; level += 1) deep = { [`l${level}`]: deep }
  const nested = profile([deep])
  assert.equal(nested.profiler.depthTruncated, true)
  assert.ok([...nested.fields.values()].every((field) => (field.details?.depth ?? 0) < FIELD_LIMITS.depth))

  const wide: BSON.Document = {}
  for (let index = 0; index < FIELD_LIMITS.fields + 50; index += 1) wide[`f${index}`] = index
  wide["x".repeat(FIELD_LIMITS.pathChars + 1)] = 1
  const many = profile([wide])
  assert.equal(many.profiler.fieldsTruncated, true)
  assert.equal(many.fields.size, FIELD_LIMITS.fields)
})

test("a dotted key that spells a nested path is listed once", () => {
  const { profiler } = profile([{ a: { b: 1 }, "a.b": "flat" }])
  assert.deepEqual(
    profiler.fields().map((field) => field.name),
    ["a", "a.b"],
  )
})

test("formatFieldType names array element types", () => {
  assert.equal(
    formatFieldType(
      [
        { type: "array", documents: 3 },
        { type: "null", documents: 1 },
      ],
      [
        { type: "int", documents: 3 },
        { type: "string", documents: 1 },
      ],
    ),
    "array<int | string> | null",
  )
  assert.equal(formatFieldType([{ type: "array", documents: 1 }], []), "array")
})
