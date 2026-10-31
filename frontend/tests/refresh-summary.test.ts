import assert from "node:assert/strict"
import test from "node:test"

import type { ManifestRefresh, RefreshCounts } from "../src/entities/manifests/types.ts"
import {
  describeChanges,
  describeCounts,
  refreshProgress,
} from "../src/features/refresh-manifest/refresh-summary.ts"

const run: ManifestRefresh = {
  id: "f1",
  connectionId: "c1",
  status: "running",
  trigger: "manual",
  phase: "reading_columns",
  objectsDone: 200,
  objectsTotal: 412,
  counts: null,
  error: null,
  triggeredBy: "u1",
  createdAt: "2026-10-31T10:00:00.000Z",
  startedAt: "2026-10-31T10:00:01.000Z",
  finishedAt: null,
}

const counts: RefreshCounts = {
  objects: 7,
  columns: 52,
  relationships: 6,
  objectsAdded: 0,
  objectsRemoved: 0,
  columnsAdded: 0,
  columnsRemoved: 0,
}

test("refreshProgress names the phase and counts objects once the total is known", () => {
  assert.deepEqual(refreshProgress(run), {
    label: "Reading columns",
    detail: "200 of 412 tables and views",
    value: 200,
    max: 412,
  })
  assert.deepEqual(refreshProgress({ ...run, status: "queued", phase: null }), {
    label: "Waiting to start",
    detail: null,
    value: null,
    max: null,
  })
  assert.equal(refreshProgress({ ...run, phase: "connecting", objectsTotal: null }).detail, null)
  assert.equal(refreshProgress({ ...run, objectsDone: 1, objectsTotal: 1 }).detail, "1 of 1 table or view")
})

test("describeCounts summarises what is published", () => {
  assert.equal(describeCounts(counts), "7 tables and views · 52 columns · 6 relationships")
  assert.equal(
    describeCounts({ ...counts, objects: 1, columns: 1, relationships: 1 }),
    "1 table or view · 1 column · 1 relationship",
  )
})

test("describeChanges lists what changed, and stays quiet on first discovery or no change", () => {
  assert.equal(describeChanges(counts), null)
  assert.equal(describeChanges({ ...counts, objectsAdded: 7, columnsAdded: 52 }), null)
  assert.equal(describeChanges({ ...counts, columnsAdded: 1 }), "1 column added")
  assert.equal(
    describeChanges({ ...counts, objectsAdded: 1, objectsRemoved: 2, columnsRemoved: 3 }),
    "1 table or view added, 2 tables and views removed, 3 columns removed",
  )
})
