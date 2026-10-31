import assert from "node:assert/strict"
import test from "node:test"

import type { ManifestRefresh, ManifestRelationship } from "../src/entities/manifests/types.ts"
import {
  endedRefreshId,
  isRefreshActive,
  refreshEndedSince,
} from "../src/entities/manifests/refresh-state.ts"
import {
  columnReferences,
  formatRowEstimate,
  isNotFound,
} from "../src/features/browse-manifest/manifest-view.ts"
import { ApiError } from "../src/shared/api/client.ts"

function relationship(overrides: Partial<ManifestRelationship>): ManifestRelationship {
  return {
    id: "r1",
    origin: "foreign_key",
    constraintName: "order_items_order_id_fkey",
    present: true,
    from: { objectId: "items", schema: "shop", name: "order_items", present: true, columns: ["order_id"] },
    to: { objectId: "orders", schema: "shop", name: "orders", present: true, columns: ["id"] },
    ...overrides,
  }
}

test("columnReferences maps each foreign-key column to the column it points at", () => {
  const composite = relationship({
    id: "r2",
    constraintName: "line_fk",
    from: { objectId: "items", schema: "shop", name: "order_items", present: true, columns: ["order_id", "line"] },
    to: { objectId: "lines", schema: "shop", name: "order_lines", present: false, columns: ["order_id", "number"] },
  })
  const references = columnReferences([relationship({}), composite])
  assert.deepEqual(references.get("order_id"), [
    { objectId: "orders", schema: "shop", name: "orders", column: "id", present: true },
    { objectId: "lines", schema: "shop", name: "order_lines", column: "order_id", present: false },
  ])
  assert.deepEqual(references.get("line"), [
    { objectId: "lines", schema: "shop", name: "order_lines", column: "number", present: false },
  ])
})

test("columnReferences ignores relationships that are no longer in the source", () => {
  assert.equal(columnReferences([relationship({ present: false })]).size, 0)
})

test("row estimates read as approximate", () => {
  assert.equal(formatRowEstimate(null), null)
  assert.equal(formatRowEstimate(1), "≈ 1 row")
  assert.equal(formatRowEstimate(4_000), "≈ 4,000 rows")
})

test("missing and malformed ids are treated as not found; other errors are not", () => {
  assert.equal(isNotFound(new ApiError(404, "NOT_FOUND", "Table or view not found")), true)
  assert.equal(isNotFound(new ApiError(422, "VALIDATION_FAILED", "Invalid params")), true)
  assert.equal(isNotFound(new ApiError(503, "STORAGE_NOT_CONFIGURED", "No storage")), false)
  assert.equal(isNotFound(new Error("offline")), false)
})

const base: Omit<ManifestRefresh, "status"> = {
  id: "f1",
  connectionId: "c1",
  trigger: "manual",
  phase: null,
  objectsDone: 0,
  objectsTotal: null,
  counts: null,
  error: null,
  triggeredBy: null,
  createdAt: "2026-10-31T10:00:00.000Z",
  startedAt: null,
  finishedAt: null,
}

test("only queued and running refreshes are active", () => {
  assert.equal(isRefreshActive({ ...base, status: "queued" }), true)
  assert.equal(isRefreshActive({ ...base, status: "running" }), true)
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(isRefreshActive({ ...base, status }), false)
  }
  assert.equal(isRefreshActive(null), false)
})

test("published metadata reloads whenever a refresh ends, including one that ended elsewhere", () => {
  const running = endedRefreshId({ ...base, status: "running" })
  const succeeded = endedRefreshId({ ...base, status: "succeeded" })
  const newer = endedRefreshId({ ...base, id: "f2", status: "succeeded" })
  assert.equal(endedRefreshId(undefined), undefined)
  assert.equal(endedRefreshId(null), null)
  assert.equal(running, null)
  assert.equal(succeeded, "f1")

  // A run watched while active, and a first run after none.
  assert.equal(refreshEndedSince(running, succeeded), true)
  assert.equal(refreshEndedSince(null, succeeded), true)
  // A cached result followed by a newer run that ended while this page was away.
  assert.equal(refreshEndedSince(succeeded, newer), true)
  // Nothing new: the same ended run, a run still active, or the first answer on load.
  assert.equal(refreshEndedSince(succeeded, succeeded), false)
  assert.equal(refreshEndedSince(succeeded, running), false)
  assert.equal(refreshEndedSince(undefined, succeeded), false)
})
