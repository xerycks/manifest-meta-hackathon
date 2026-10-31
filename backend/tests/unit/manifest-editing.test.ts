import assert from "node:assert/strict"
import test from "node:test"

import { canEditEntry, createEntrySchema, updateEntrySchema } from "../../src/knowledge/schemas.js"
import {
  columnPatchSchema,
  objectPatchSchema,
  typeFamily,
  typesCompatible,
  updateRelationshipSchema,
} from "../../src/manifests/editor-schemas.js"

const column = (dataType: string, enumValues: string[] | null = null) => ({ dataType, enumValues })

test("type families ignore modifiers and widths but keep arrays apart", () => {
  assert.equal(typeFamily(column("integer")), "number")
  assert.equal(typeFamily(column("numeric(12,2)")), "number")
  assert.equal(typeFamily(column("double precision")), "number")
  assert.equal(typeFamily(column("character varying(80)")), "text")
  assert.equal(typeFamily(column("timestamp with time zone")), "timestamp")
  assert.equal(typeFamily(column("time without time zone")), "time")
  assert.equal(typeFamily(column("uuid")), "uuid")
  assert.equal(typeFamily(column("bit(8)")), "bit")
  assert.equal(typeFamily(column("integer[]")), "number[]")
  assert.equal(typeFamily(column("shop.gift_wrap", ["none", "box"])), "text")
})

test("MongoDB field types: nulls ignored, arrays match their elements, mixes stay mixed", () => {
  assert.equal(typeFamily(column("int")), "number")
  assert.equal(typeFamily(column("long | null")), "number")
  assert.equal(typeFamily(column("int | double")), "number")
  assert.equal(typeFamily(column("string")), "text")
  assert.equal(typeFamily(column("objectId")), "objectid")
  assert.equal(typeFamily(column("array<int> | null")), "number")
  assert.equal(typeFamily(column("int | string")), "number | text")
  assert.equal(typeFamily(column("array<int | string>")), "number | text")
  assert.ok(typesCompatible(column("int"), column("array<long>")))
  assert.ok(typesCompatible(column("objectId"), column("objectId | null")))
  assert.ok(!typesCompatible(column("objectId"), column("string")))
  assert.ok(!typesCompatible(column("int | string"), column("int")))
})

test("relationships need comparable column types", () => {
  assert.ok(typesCompatible(column("integer"), column("bigint")))
  assert.ok(typesCompatible(column("text"), column("character varying(40)")))
  assert.ok(typesCompatible(column("date"), column("timestamp without time zone")))
  assert.ok(typesCompatible(column("shop.status", ["paid"]), column("text")))
  assert.ok(!typesCompatible(column("integer"), column("text")))
  assert.ok(!typesCompatible(column("uuid"), column("text")))
  assert.ok(!typesCompatible(column("integer[]"), column("integer")))
  assert.ok(!typesCompatible(column("boolean"), column("timestamp with time zone")))
})

test("object and column patches trim text, clear empty fields, and need a change", () => {
  const parsed = objectPatchSchema.parse({
    version: 3,
    label: "  Orders ",
    description: "  \n",
    rowMeaning: null,
  })
  assert.deepEqual(parsed, { version: 3, label: "Orders", description: null, rowMeaning: null })
  assert.equal(
    objectPatchSchema.parse({ version: 1, description: "- one\n- two\n\n" }).description,
    "- one\n- two",
  )
  assert.equal(objectPatchSchema.safeParse({ version: 1 }).success, false)
  assert.equal(objectPatchSchema.safeParse({ version: 0, label: "x" }).success, false)
  assert.equal(objectPatchSchema.safeParse({ label: "x" }).success, false)
  assert.equal(objectPatchSchema.safeParse({ version: 1, comment: "x" }).success, false)
  assert.equal(columnPatchSchema.safeParse({ version: 1, unit: "x".repeat(101) }).success, false)
  assert.deepEqual(columnPatchSchema.parse({ version: 2, unit: " USD " }), { version: 2, unit: "USD" })
})

test("relationship patches change both columns together", () => {
  const ids = { fromColumnId: crypto.randomUUID(), toColumnId: crypto.randomUUID() }
  assert.ok(updateRelationshipSchema.safeParse({ version: 1, ...ids }).success)
  assert.ok(updateRelationshipSchema.safeParse({ version: 1, remark: "" }).success)
  assert.equal(updateRelationshipSchema.parse({ version: 1, remark: "  " }).remark, null)
  assert.equal(
    updateRelationshipSchema.safeParse({ version: 1, fromColumnId: ids.fromColumnId }).success,
    false,
  )
})

test("knowledge entries need a title; anyone edits their own, managers edit any", () => {
  assert.deepEqual(createEntrySchema.parse({ title: " Net revenue " }), { title: "Net revenue", body: "" })
  assert.equal(createEntrySchema.safeParse({ title: "   " }).success, false)
  assert.equal(updateEntrySchema.safeParse({ version: 1 }).success, false)
  assert.ok(updateEntrySchema.safeParse({ version: 1, connectionId: null }).success)

  const entry = { createdBy: { id: "author", name: "Ana" } }
  assert.ok(canEditEntry(entry, "author", "member"))
  assert.ok(!canEditEntry(entry, "someone-else", "member"))
  assert.ok(canEditEntry(entry, "someone-else", "admin"))
  assert.ok(canEditEntry(entry, "someone-else", "owner"))
  assert.ok(!canEditEntry({ createdBy: null }, "someone-else", "member"))
})
