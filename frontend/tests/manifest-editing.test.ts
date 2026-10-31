import assert from "node:assert/strict"
import test from "node:test"

import type { ManifestRelationship } from "../src/entities/manifests/types.ts"
import {
  COLUMN_FIELDS,
  conflictFields,
  EMPTY_RELATIONSHIP,
  newRelationship,
  relationshipFields,
  relationshipPatch,
} from "../src/features/edit-manifests/meaning-fields.ts"
import { canDeleteEntry, canEditEntry, entryPatch, newEntry, titleProblem } from "../src/features/manage-knowledge/knowledge-form.ts"
import { startDraft, withConflict } from "../src/shared/lib/draft.ts"

const relationship: ManifestRelationship = {
  id: "r1",
  origin: "manual",
  constraintName: null,
  present: true,
  from: { objectId: "customers", schema: "shop", name: "customers", present: true, columns: ["referred_by"] },
  to: { objectId: "customers", schema: "shop", name: "customers", present: true, columns: ["id"] },
  remark: "Referral program",
  version: 3,
  needsReview: false,
}
const customerColumns = [
  { id: "c-id", name: "id" },
  { id: "c-ref", name: "referred_by" },
]
const orderColumns = [{ id: "o-cust", name: "customer_id" }]

test("editing only a remark sends the remark; moving an end sends both column ids", () => {
  const start = startDraft(relationshipFields(relationship), relationship.version)
  const remarked = { ...start, draft: { ...start.draft, remark: "  " } }
  assert.deepEqual(relationshipPatch(remarked, customerColumns, customerColumns), { version: 3, remark: null })

  const moved = { ...start, draft: { ...start.draft, toObjectId: "orders", toColumn: "customer_id" } }
  assert.deepEqual(relationshipPatch(moved, customerColumns, orderColumns), {
    version: 3,
    fromColumnId: "c-ref",
    toColumnId: "o-cust",
  })
  // The new target's columns have not loaded yet.
  assert.equal(relationshipPatch(moved, customerColumns, []), null)
})

test("a new relationship needs both columns", () => {
  assert.equal(newRelationship(EMPTY_RELATIONSHIP, customerColumns, orderColumns), null)
  assert.deepEqual(
    newRelationship(
      { fromColumn: "id", toObjectId: "orders", toColumn: "customer_id", remark: " Same customer " },
      customerColumns,
      orderColumns,
    ),
    { fromColumnId: "c-id", toColumnId: "o-cust", remark: "Same customer" },
  )
})

test("the conflict notice lists their changed fields with their values", () => {
  const start = startDraft({ label: "Total", unit: "", description: "Old", valueNotes: "" }, 2)
  const conflicted = withConflict(start, { label: "Total", unit: "EUR", description: "New **text**", valueNotes: "" }, 3)
  assert.deepEqual(conflictFields(conflicted, COLUMN_FIELDS), [
    { label: "Unit", value: "EUR", markdown: false },
    { label: "Description", value: "New **text**", markdown: true },
  ])
  assert.deepEqual(conflictFields(start, COLUMN_FIELDS), [])
})

test("knowledge entries send trimmed titles, keep empty bodies, and unlink with null", () => {
  assert.equal(titleProblem("  "), "Enter a title.")
  assert.match(titleProblem("x".repeat(201)) ?? "", /at most 200/)
  assert.equal(titleProblem(" Churn "), null)
  assert.deepEqual(newEntry({ title: " Churn ", body: "", connectionId: "" }), {
    title: "Churn",
    body: "",
    connectionId: null,
  })
  const start = startDraft({ title: "Churn", body: "Old", connectionId: "c1" }, 2)
  const changed = { ...start, draft: { title: "Churn ", body: "", connectionId: "" } }
  assert.deepEqual(entryPatch(changed), { version: 2, title: "Churn", body: "", connectionId: null })
})

test("knowledge permissions mirror the server", () => {
  const entry = { createdBy: { id: "u1", name: "Ana" } }
  assert.ok(canEditEntry(entry, "u1", "member"))
  assert.ok(!canEditEntry(entry, "u2", "member"))
  assert.ok(canEditEntry(entry, "u2", "admin"))
  assert.ok(!canEditEntry(entry, undefined, "member"))
  assert.ok(canDeleteEntry("owner"))
  assert.ok(!canDeleteEntry("member"))
  assert.ok(!canDeleteEntry(null))
})
