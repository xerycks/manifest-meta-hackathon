import assert from "node:assert/strict"
import test from "node:test"

import {
  describeResult,
  displayCell,
  formatDateTime,
  isMissing,
  truncationNotice,
} from "../src/entities/queries/cells.ts"
import type { QueryResult, ResultColumn } from "../src/entities/queries/types.ts"

const column = (kind: ResultColumn["kind"], type = kind): ResultColumn => ({ name: "value", type, kind })

test("NULL and missing are labelled differently and never shown blank", () => {
  const nullCell = displayCell(null, column("text"))
  const missingCell = displayCell({ $missing: true }, column("text"))
  assert.equal(nullCell.text, "NULL")
  assert.equal(nullCell.tone, "null")
  assert.equal(missingCell.text, "missing")
  assert.equal(missingCell.tone, "missing")
  assert.equal(isMissing({ $missing: true }), true)
  assert.equal(isMissing(null), false)
  assert.equal(isMissing("missing"), false)
})

test("numbers are right-aligned and exact numeric strings are shown digit for digit", () => {
  assert.deepEqual(displayCell("9223372036854775807", column("integer", "bigint")), {
    text: "9223372036854775807",
    tone: "value",
    align: "right",
  })
  assert.equal(displayCell("12345678901234567890.12", column("decimal")).text, "12345678901234567890.12")
  assert.equal(displayCell(42, column("integer")).align, "right")
  assert.equal(displayCell("NaN", column("float")).text, "NaN")
  // A number in a mixed MongoDB column still reads as a number.
  assert.equal(displayCell(7, column("unknown", "int | string")).align, "right")
  assert.equal(displayCell("seven", column("unknown", "int | string")).align, "left")
  assert.equal(displayCell(true, column("boolean")).text, "true")
})

test("datetimes keep every digit and name their zone", () => {
  assert.equal(formatDateTime("2026-10-31T09:30:00.123456Z"), "2026-10-31 09:30:00.123456 UTC")
  assert.equal(formatDateTime("2026-01-03T04:49:03+05:30"), "2026-01-03 04:49:03 +05:30")
  assert.equal(formatDateTime("2026-10-31T09:30:00"), "2026-10-31 09:30:00")
  assert.equal(formatDateTime("infinity"), "infinity")
  const cell = displayCell("2026-10-31T09:30:00.250Z", column("datetime"))
  assert.equal(cell.text, "2026-10-31 09:30:00.250 UTC")
  assert.equal(cell.title, "2026-10-31T09:30:00.250Z")
})

test("long binaries and text are shortened, with the full value kept as the title", () => {
  const blob = `\\x${"ab".repeat(100)}`
  const binary = displayCell(blob, column("binary", "bytea"))
  assert.match(binary.text, /^\\xabab.*… \(100 bytes\)$/)
  assert.equal(binary.title, blob)
  assert.equal(displayCell("\\xdead", column("binary")).title, "2 bytes")
  const long = "x".repeat(250)
  const text = displayCell(long, column("text"))
  assert.equal(text.text.length, 201)
  assert.equal(text.title, long)
})

const result = (overrides: Partial<QueryResult>): QueryResult => ({
  columns: [column("integer")],
  rows: [[1], [2]],
  rowCount: 2,
  truncated: false,
  truncatedBy: null,
  durationMs: 1234,
  ...overrides,
})

test("result summaries count rows, time, stored snapshots, and why a result was cut", () => {
  assert.equal(describeResult(result({})), "2 rows · 1,234 ms")
  assert.equal(describeResult(result({ rowCount: 1, rows: [[1]] })), "1 row · 1,234 ms")
  assert.equal(
    describeResult(result({ rowCount: 4_800 }), true),
    "First 2 of 4,800 rows (stored result) · 1,234 ms",
  )
  assert.equal(truncationNotice(result({})), null)
  assert.match(truncationNotice(result({ truncated: true, truncatedBy: "rows" })) ?? "", /first 2 rows \(the row limit\)/)
  assert.match(truncationNotice(result({ truncated: true, truncatedBy: "bytes" })) ?? "", /5 MB limit after 2 rows/)
})
