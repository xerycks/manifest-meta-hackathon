import assert from "node:assert/strict"
import test from "node:test"

import { GRID, PANEL_SIZES, type PanelBox, type PanelKind } from "../src/entities/dashboards/types.ts"
import {
  arrange,
  clampBox,
  compact,
  describeBox,
  gridDelta,
  keyboardStep,
  layoutInput,
  overlaps,
  sameLayout,
  stackOrder,
  type LayoutItem,
} from "../src/features/dashboard/layout.ts"

const item = (
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: PanelKind = "markdown",
): LayoutItem => ({
  id,
  kind,
  x,
  y,
  w,
  h,
})
const boxes = (items: LayoutItem[]) =>
  Object.fromEntries(items.map(({ id, x, y, w, h }) => [id, [x, y, w, h]]))

function noOverlaps(items: LayoutItem[]) {
  items.forEach((a, index) => {
    for (const b of items.slice(index + 1)) assert.equal(overlaps(a, b), false, `${a.id} overlaps ${b.id}`)
  })
}

test("boxes stay on the grid and at least their kind's minimum size", () => {
  assert.deepEqual(clampBox({ x: 10, y: -2, w: 6, h: 1 }, "bar"), { x: 6, y: 0, w: 6, h: 3 })
  assert.deepEqual(clampBox({ x: -1, y: 4, w: 20, h: 30 }, "table"), { x: 0, y: 4, w: 12, h: GRID.maxHeight })
  assert.deepEqual(clampBox({ x: 3, y: 1, w: 1, h: 1 }, "markdown"), { x: 3, y: 1, w: 2, h: 1 })
  for (const [kind, size] of Object.entries(PANEL_SIZES)) {
    assert.ok(size.default.w >= size.min.w && size.default.h >= size.min.h, kind)
  }
})

test("a moved panel pushes the panels it lands on down, and the rest close up around it", () => {
  const layout = [item("a", 0, 0, 6, 2), item("b", 6, 0, 6, 2), item("c", 0, 2, 12, 2)]
  // b moves onto a's spot: a goes below it, and c floats up under both.
  const moved = arrange(layout, "b", { x: 0, y: 0, w: 6, h: 2 })
  assert.deepEqual(boxes(moved), { a: [0, 2, 6, 2], b: [0, 0, 6, 2], c: [0, 4, 12, 2] })
  noOverlaps(moved)
  // Order is kept, whatever moved.
  assert.deepEqual(
    moved.map((entry) => entry.id),
    ["a", "b", "c"],
  )
  // A resize that grows into a neighbour pushes it down.
  const grown = arrange(layout, "a", { x: 0, y: 0, w: 6, h: 3 })
  assert.deepEqual(boxes(grown), { a: [0, 0, 6, 3], b: [6, 0, 6, 2], c: [0, 3, 12, 2] })
  noOverlaps(grown)
})

test("gaps close up, except above the panel being moved", () => {
  const gappy = [item("a", 0, 3, 4, 2), item("b", 4, 6, 4, 2), item("c", 0, 9, 4, 1)]
  assert.deepEqual(boxes(compact(gappy)), { a: [0, 0, 4, 2], b: [4, 0, 4, 2], c: [0, 2, 4, 1] })
  assert.deepEqual(boxes(compact(gappy, "b")), { a: [0, 0, 4, 2], b: [4, 6, 4, 2], c: [0, 2, 4, 1] })
})

test("arrow keys move a panel a cell at a time, and with Shift resize it", () => {
  const box: PanelBox = { x: 2, y: 3, w: 4, h: 2 }
  assert.deepEqual(keyboardStep(box, "ArrowLeft", false), { x: 1, y: 3, w: 4, h: 2 })
  assert.deepEqual(keyboardStep(box, "ArrowDown", false), { x: 2, y: 4, w: 4, h: 2 })
  assert.deepEqual(keyboardStep(box, "ArrowRight", true), { x: 2, y: 3, w: 5, h: 2 })
  assert.deepEqual(keyboardStep(box, "ArrowUp", true), { x: 2, y: 3, w: 4, h: 1 })
  assert.equal(keyboardStep(box, "Enter", false), null)

  // Two steps down past a panel of the same height swap them.
  let layout = [item("a", 0, 0, 6, 2), item("b", 0, 2, 6, 2)]
  for (let step = 0; step < 2; step += 1) {
    const a = layout.find((entry) => entry.id === "a") as LayoutItem
    layout = arrange(layout, "a", keyboardStep(a, "ArrowDown", false) as PanelBox)
    noOverlaps(layout)
  }
  assert.deepEqual(boxes(layout), { a: [0, 2, 6, 2], b: [0, 0, 6, 2] })
  // A panel at the edge stays on the grid, and a resize stops at the kind's minimum.
  const edge = arrange([item("a", 0, 0, 3, 3, "bar")], "a", { x: -1, y: -1, w: 2, h: 2 })
  assert.deepEqual(boxes(edge), { a: [0, 0, 3, 3] })
})

test("narrow screens stack panels top to bottom, then left to right", () => {
  const panels = [
    { id: "right", layout: { x: 6, y: 0, w: 6, h: 2 } },
    { id: "below", layout: { x: 0, y: 4, w: 12, h: 2 } },
    { id: "left", layout: { x: 0, y: 0, w: 6, h: 4 } },
    { id: "middle", layout: { x: 6, y: 2, w: 6, h: 2 } },
  ]
  assert.deepEqual(
    stackOrder(panels).map((panel) => panel.id),
    ["left", "right", "middle", "below"],
  )
})

test("pointer movement snaps to whole cells, and layouts save every box", () => {
  // A 960px canvas: columns of 66.67px plus 16px gaps; rows of 72px plus 16px.
  assert.deepEqual(gridDelta(170, 90, 960), { columns: 2, rows: 1 })
  assert.deepEqual(gridDelta(-40, -30, 960), { columns: 0, rows: 0 })
  assert.deepEqual(gridDelta(-130, -170, 960), { columns: -2, rows: -2 })

  const layout = [item("a", 0, 0, 6, 2), item("b", 6, 0, 6, 2)]
  assert.deepEqual(layoutInput(layout, 7), {
    version: 7,
    boxes: [
      { panelId: "a", x: 0, y: 0, w: 6, h: 2 },
      { panelId: "b", x: 6, y: 0, w: 6, h: 2 },
    ],
  })
  assert.equal(sameLayout(layout, [...layout].reverse()), true)
  assert.equal(sameLayout(layout, arrange(layout, "a", { x: 0, y: 0, w: 6, h: 3 })), false)
  assert.equal(describeBox({ x: 0, y: 2, w: 1, h: 4 }), "Column 1, row 3, 1 column wide, 4 rows tall")
})
