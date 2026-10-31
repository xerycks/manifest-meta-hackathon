import assert from "node:assert/strict"
import test from "node:test"

import {
  bottom,
  fitKind,
  GRID,
  layoutProblem,
  overlaps,
  PANEL_SIZES,
  pushDown,
} from "../../src/dashboards/layout.js"
import type { PanelKind } from "../../src/dashboards/schemas.js"

const box = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h })

test("every kind's default box is at least its minimum and fits the grid", () => {
  for (const [kind, { min, default: size }] of Object.entries(PANEL_SIZES)) {
    assert.ok(size.w >= min.w && size.h >= min.h, kind)
    assert.ok(size.w <= GRID.columns && size.h <= GRID.maxHeight, kind)
  }
})

test("layouts must fit the grid and the panels' kinds, without overlaps", () => {
  const kinds = new Map<string, PanelKind>([
    ["a", "bar"],
    ["b", "number"],
    ["c", "markdown"],
  ])
  const fine = [box("a", 0, 0, 6, 4), box("b", 6, 0, 3, 2), box("c", 6, 2, 6, 1)]
  assert.equal(layoutProblem(fine, kinds), null)
  assert.deepEqual(layoutProblem([box("a", 8, 0, 6, 4)], kinds), {
    panelId: "a",
    message: "A panel must fit within the 12 columns of the grid.",
  })
  assert.deepEqual(layoutProblem([box("a", 0, 0, 2, 4)], kinds), {
    panelId: "a",
    message: "This bar panel must be at least 3 columns wide and 3 rows tall.",
  })
  assert.deepEqual(layoutProblem([box("a", 0, 0, 6, 4), box("b", 5, 3, 3, 2)], kinds), {
    panelId: "a",
    message: "Panels cannot overlap.",
  })
  // Touching edges are fine.
  assert.equal(layoutProblem([box("a", 0, 0, 6, 4), box("b", 6, 3, 3, 2)], kinds), null)
  assert.equal(layoutProblem([box("z", 0, 0, 3, 3)], kinds)?.message, "That panel is not on this dashboard.")
})

test("overlaps and bottom measure boxes on the grid", () => {
  assert.equal(overlaps(box("a", 0, 0, 4, 2), box("b", 4, 0, 4, 2)), false)
  assert.equal(overlaps(box("a", 0, 0, 4, 2), box("b", 3, 1, 4, 2)), true)
  assert.equal(bottom([]), 0)
  assert.equal(bottom([box("a", 0, 0, 4, 2), box("b", 4, 3, 4, 5)]), 8)
})

test("a box put in place pushes the boxes it lands on down, and leaves the rest", () => {
  const boxes = [box("a", 0, 0, 6, 2), box("b", 0, 2, 6, 3), box("c", 6, 0, 6, 2), box("d", 0, 5, 12, 2)]
  const moved = pushDown(boxes, box("c", 0, 1, 6, 2))
  const byId = new Map(moved.map((item) => [item.id, item]))
  assert.deepEqual(byId.get("c"), box("c", 0, 1, 6, 2))
  assert.deepEqual(byId.get("a"), box("a", 0, 3, 6, 2))
  assert.deepEqual(byId.get("b"), box("b", 0, 5, 6, 3))
  assert.deepEqual(byId.get("d"), box("d", 0, 8, 12, 2))
  assert.equal(layoutProblem(moved, new Map(moved.map((item) => [item.id, "markdown" as const]))), null)
})

test("a panel that changes kind grows to the new kind's minimum and pushes others down", () => {
  const boxes = [box("note", 10, 0, 2, 1), box("below", 8, 1, 4, 2)]
  const fitted = fitKind(boxes, "note", "bar")
  assert.ok(fitted)
  const byId = new Map(fitted.map((item) => [item.id, item]))
  assert.deepEqual(byId.get("note"), box("note", 9, 0, 3, 3))
  assert.deepEqual(byId.get("below"), box("below", 8, 3, 4, 2))
  assert.equal(fitKind(boxes, "note", "markdown"), null)
})
