import assert from "node:assert/strict"
import test from "node:test"

import { Binary, Decimal128, Double, Int32, Long, ObjectId, UUID } from "mongodb"
import type { FieldDef } from "pg"

import { mongoCell, MongoRows } from "../../src/queries/mongodb-values.js"
import { isoTimestamp, postgresColumns, type PostgresTypeInfo } from "../../src/queries/postgres-values.js"
import { ResultCollector, snapshotRows } from "../../src/queries/results.js"
import { MISSING, type Cell } from "../../src/queries/schemas.js"

const field = (name: string, dataTypeID: number) => ({ name, dataTypeID }) as FieldDef

function types(...entries: [number, string, string, number | null][]): Map<number, PostgresTypeInfo> {
  return new Map(entries.map(([oid, name, category, base]) => [oid, { oid, name, category, base }]))
}

test("PostgreSQL text values keep exact numbers, duplicate names, and NULL", () => {
  const columns = postgresColumns(
    [
      field("id", 23),
      field("id", 20),
      field("total", 1700),
      field("ratio", 701),
      field("ratio", 701),
      field("paid", 16),
      field("note", 25),
    ],
    types(
      [23, "integer", "N", null],
      [20, "bigint", "N", null],
      [1700, "numeric(12,2)", "N", null],
      [701, "double precision", "N", null],
      [16, "boolean", "B", null],
      [25, "text", "S", null],
    ),
  )
  assert.deepEqual(
    columns.map((entry) => entry.column),
    [
      { name: "id", type: "integer", kind: "integer" },
      { name: "id", type: "bigint", kind: "integer" },
      { name: "total", type: "numeric(12,2)", kind: "decimal" },
      { name: "ratio", type: "double precision", kind: "float" },
      { name: "ratio", type: "double precision", kind: "float" },
      { name: "paid", type: "boolean", kind: "boolean" },
      { name: "note", type: "text", kind: "text" },
    ],
  )
  const values = ["42", "9223372036854775807", "12345678901234567890.12", "0.1", "NaN", "t", null]
  assert.deepEqual(
    values.map((value, index) => columns[index]?.encode(value)),
    [42, "9223372036854775807", "12345678901234567890.12", 0.1, "NaN", true, null],
  )
})

test("PostgreSQL dates, binaries, json, uuids, and domains get their kinds", () => {
  const columns = postgresColumns(
    [
      field("at", 1184),
      field("local", 1114),
      field("day", 1082),
      field("blob", 17),
      field("doc", 3802),
      field("key", 2950),
      field("cents", 90001),
      field("mood", 90002),
    ],
    types(
      [1184, "timestamp with time zone", "D", null],
      [1114, "timestamp without time zone", "D", null],
      [1082, "date", "D", null],
      [17, "bytea", "U", null],
      [3802, "jsonb", "U", null],
      [2950, "uuid", "U", null],
      [90001, "shop.cents", "N", 20],
      [90002, "shop.mood", "E", null],
    ),
  )
  assert.deepEqual(
    columns.map((entry) => entry.column.kind),
    ["datetime", "datetime", "date", "binary", "json", "id", "integer", "text"],
  )
  assert.equal(columns[0]?.encode("2026-10-31 09:30:00.123456+00"), "2026-10-31T09:30:00.123456Z")
  assert.equal(columns[1]?.encode("2026-10-31 09:30:00"), "2026-10-31T09:30:00")
  assert.equal(columns[3]?.encode("\\xdeadbeef"), "\\xdeadbeef")
  // A domain over bigint keeps every digit.
  assert.equal(columns[6]?.encode("9007199254740993"), "9007199254740993")
})

test("timestamps become ISO 8601 with their offset; values ISO cannot express stay as they are", () => {
  assert.equal(isoTimestamp("2026-01-03 04:49:03.00954+05:30"), "2026-01-03T04:49:03.00954+05:30")
  assert.equal(isoTimestamp("2026-01-03 04:49:03-03"), "2026-01-03T04:49:03-03:00")
  assert.equal(isoTimestamp("infinity"), "infinity")
  assert.equal(isoTimestamp("0044-03-15 00:00:00 BC"), "0044-03-15 00:00:00 BC")
})

test("MongoDB values keep Long and Decimal128 exact and render ids, dates, and binaries", () => {
  assert.equal(mongoCell(new Int32(7)), 7)
  assert.equal(mongoCell(Long.fromString("9223372036854775807")), "9223372036854775807")
  assert.equal(mongoCell(Decimal128.fromString("12345678901234567890.123456789")), "12345678901234567890.123456789")
  assert.equal(mongoCell(new Double(0.5)), 0.5)
  assert.equal(mongoCell(new Double(Number.POSITIVE_INFINITY)), "Infinity")
  assert.equal(mongoCell(new ObjectId("64b7f0c2a1b2c3d4e5f60718")), "64b7f0c2a1b2c3d4e5f60718")
  assert.equal(mongoCell(new Date("2026-10-31T09:30:00.250Z")), "2026-10-31T09:30:00.250Z")
  assert.equal(mongoCell(new Binary(Buffer.from([0xde, 0xad]))), "\\xdead")
  const uuid = new UUID("0f8e4a52-2c1d-4c3b-9a7e-2b6f1d0c9e11")
  assert.equal(mongoCell(uuid.toBinary()), "0f8e4a52-2c1d-4c3b-9a7e-2b6f1d0c9e11")
  assert.equal(mongoCell(null), null)
  // Nested values are Extended JSON text that keeps exact numbers.
  assert.equal(
    mongoCell({ qty: new Int32(2), price: Decimal128.fromString("12.50"), big: Long.fromString("9007199254740993"), id: new ObjectId("64b7f0c2a1b2c3d4e5f60718") }),
    '{"qty":2,"price":{"$numberDecimal":"12.50"},"big":{"$numberLong":"9007199254740993"},"id":{"$oid":"64b7f0c2a1b2c3d4e5f60718"}}',
  )
  assert.equal(mongoCell([new Int32(1), "a"]), '[1,"a"]')
})

test("MongoDB rows tell null apart from a missing field and pad rows read before a field appeared", () => {
  const collector = new ResultCollector(10)
  const rows = new MongoRows(collector)
  assert.equal(rows.add({ _id: new Int32(1), name: "Ava" }), true)
  assert.equal(rows.add({ _id: new Int32(2), name: null, points: Long.fromString("5") }), true)
  assert.equal(rows.add({ _id: new Int32(3), points: new Int32(4), name: "Kai" }), true)
  assert.deepEqual(rows.columns(), [
    { name: "_id", type: "int", kind: "integer" },
    { name: "name", type: "string", kind: "text" },
    { name: "points", type: "long | int", kind: "integer" },
  ])
  assert.deepEqual(collector.rows, [
    [1, "Ava", MISSING],
    [2, null, "5"],
    [3, "Kai", 4],
  ])
  assert.equal(JSON.stringify(collector.rows[0]), '[1,"Ava",{"$missing":true}]')
})

test("padding earlier rows for a new field counts toward the byte limit", () => {
  const collector = new ResultCollector(5_000, 64 * 1024)
  const rows = new MongoRows(collector)
  for (let index = 0; index < 1_000; index += 1) assert.equal(rows.add({ a: new Int32(index) }), true)
  // 2,000 new fields would pad the 1,000 earlier rows with 2,000,000 missing cells.
  const wide = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`f${index}`, new Int32(1)]))
  assert.equal(rows.add(wide), false)
  assert.equal(collector.truncatedBy, "bytes")
  assert.equal(rows.columns().length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(collector.rows)) <= 64 * 1024)
})

test("mixed field types report every type and an unknown kind", () => {
  const rows = new MongoRows(new ResultCollector(10))
  rows.add({ rating: new Int32(4) })
  rows.add({ rating: "five" })
  assert.deepEqual(rows.columns(), [{ name: "rating", type: "int | string", kind: "unknown" }])
})

test("the collector stops at maxRows or the byte limit and says which", () => {
  const byRows = new ResultCollector(2)
  assert.equal(byRows.add([1]), true)
  assert.equal(byRows.add([2]), true)
  assert.equal(byRows.add([3]), false)
  assert.deepEqual(byRows.rows, [[1], [2]])
  assert.equal(byRows.truncatedBy, "rows")

  const byBytes = new ResultCollector(100, 20)
  assert.equal(byBytes.add(["0123456789"]), true)
  assert.equal(byBytes.add(["0123456789"]), false)
  assert.equal(byBytes.truncatedBy, "bytes")
  assert.equal(byBytes.rows.length, 1)
})

test("snapshots keep the leading rows within the row and byte budgets", () => {
  const rows: Cell[][] = Array.from({ length: 10 }, (_, index) => [index, "x".repeat(10)])
  assert.equal(snapshotRows(rows, 4).length, 4)
  assert.deepEqual(snapshotRows(rows, 100, 40), rows.slice(0, 2))
  assert.equal(snapshotRows(rows).length, 10)
})
