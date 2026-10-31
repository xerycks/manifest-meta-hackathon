import assert from "node:assert/strict"
import test from "node:test"

import { ApiError } from "../src/shared/api/client.ts"
import {
  apiErrorMessage,
  draftPatch,
  fieldsOf,
  isDirty,
  rebaseDraft,
  staleRecord,
  startDraft,
  takeTheirs,
  theirChanges,
  withConflict,
  type DraftState,
} from "../src/shared/lib/draft.ts"

type Field = "label" | "unit" | "description"
const KEYS: Field[] = ["label", "unit", "description"]

function edited(state: DraftState<Field>, changes: Partial<Record<Field, string>>): DraftState<Field> {
  return { ...state, draft: { ...state.draft, ...changes } }
}

const saved = { label: "Order total", unit: null, description: "Net revenue.", version: 4 }

test("a draft starts from the saved fields and sends only what changed", () => {
  const start = startDraft(fieldsOf(saved, KEYS), saved.version)
  assert.deepEqual(start.draft, { label: "Order total", unit: "", description: "Net revenue." })
  assert.equal(isDirty(start), false)
  assert.deepEqual(draftPatch(start), { version: 4 })

  const draft = edited(start, { unit: "USD", description: "   " })
  assert.equal(isDirty(draft), true)
  // Blank fields are sent as null so the server clears them.
  assert.deepEqual(draftPatch(draft), { version: 4, unit: "USD", description: null })
})

test("a conflict keeps the draft and names the fields the other person changed", () => {
  const start = startDraft(fieldsOf(saved, KEYS), saved.version)
  const draft = edited(start, { unit: "USD" })
  const theirs = { label: "Total charged", unit: null, description: "Net revenue.", version: 5 }
  const conflicted = withConflict(draft, fieldsOf(theirs, KEYS), theirs.version)
  assert.deepEqual(conflicted.draft, draft.draft)
  assert.deepEqual(theirChanges(conflicted), ["label"])
  assert.equal(conflicted.version, 4, "still based on the old version until the user decides")
})

test("keeping my version rebases the draft so their other changes survive", () => {
  const start = startDraft(fieldsOf(saved, KEYS), saved.version)
  const draft = edited(start, { unit: "USD", description: "Mine." })
  const theirs = { label: "Total charged", unit: null, description: "Theirs.", version: 5 }
  const rebased = rebaseDraft(withConflict(draft, fieldsOf(theirs, KEYS), theirs.version))
  assert.equal(rebased.conflict, null)
  assert.equal(rebased.version, 5)
  assert.deepEqual(rebased.draft, { label: "Total charged", unit: "USD", description: "Mine." })
  // Their label is not sent back; my two changes are.
  assert.deepEqual(draftPatch(rebased), { version: 5, unit: "USD", description: "Mine." })
})

test("using their version drops the draft", () => {
  const start = startDraft(fieldsOf(saved, KEYS), saved.version)
  const theirs = { label: "Total charged", unit: "EUR", description: null, version: 5 }
  const taken = takeTheirs(withConflict(edited(start, { unit: "USD" }), fieldsOf(theirs, KEYS), 5))
  assert.deepEqual(taken.draft, { label: "Total charged", unit: "EUR", description: "" })
  assert.equal(isDirty(taken), false)
  assert.equal(taken.version, 5)
  assert.equal(rebaseDraft(start), start, "nothing to rebase without a conflict")
})

test("staleRecord reads the current record from a 409 only", () => {
  const current = { id: "o1", version: 7 }
  assert.deepEqual(staleRecord(new ApiError(409, "CONFLICT", "Stale", "r1", { current })), current)
  assert.equal(staleRecord(new ApiError(409, "CONFLICT", "Title taken")), null)
  assert.equal(staleRecord(new ApiError(422, "VALIDATION_FAILED", "Invalid", undefined, { current })), null)
  assert.equal(staleRecord(new Error("network")), null)
})

test("apiErrorMessage spells out validation issues", () => {
  const invalid = new ApiError(422, "VALIDATION_FAILED", "Invalid body", undefined, {
    issues: [{ path: "label", message: "The label can be at most 200 characters" }],
  })
  assert.equal(apiErrorMessage(invalid), "The label can be at most 200 characters")
  assert.equal(apiErrorMessage(new ApiError(403, "FORBIDDEN", "Not allowed")), "Not allowed")
  assert.equal(apiErrorMessage("boom"), "Something went wrong. Please try again.")
})
