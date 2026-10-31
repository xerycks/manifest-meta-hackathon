import type { PanelBox, PanelKind } from "./schemas.js"

/** The dashboard grid: 12 columns, panels at most 12 rows tall, starting no lower than row 500. */
export const GRID = { columns: 12, maxHeight: 12, maxRow: 500 } as const

interface Size {
  w: number
  h: number
}

/** Each kind's smallest box that still shows its content, and the box a new panel gets. */
export const PANEL_SIZES: Record<PanelKind, { min: Size; default: Size }> = {
  number: { min: { w: 2, h: 2 }, default: { w: 3, h: 2 } },
  table: { min: { w: 4, h: 3 }, default: { w: 12, h: 4 } },
  markdown: { min: { w: 2, h: 1 }, default: { w: 4, h: 2 } },
  bar: { min: { w: 3, h: 3 }, default: { w: 6, h: 4 } },
  line: { min: { w: 3, h: 3 }, default: { w: 6, h: 4 } },
  gauge: { min: { w: 2, h: 2 }, default: { w: 3, h: 3 } },
  ticker: { min: { w: 3, h: 2 }, default: { w: 12, h: 2 } },
  sankey: { min: { w: 4, h: 3 }, default: { w: 6, h: 5 } },
}

export type PlacedBox = PanelBox & { id: string }

export function overlaps(a: PanelBox, b: PanelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** The row below every box: where a new panel goes. */
export function bottom(boxes: PanelBox[]): number {
  return boxes.reduce((lowest, box) => Math.max(lowest, box.y + box.h), 0)
}

/**
 * The first reason a layout does not fit, or null: each box must lie on the
 * grid, be at least its kind's minimum size, and not overlap another.
 */
export function layoutProblem(
  boxes: PlacedBox[],
  kinds: Map<string, PanelKind>,
): { panelId: string; message: string } | null {
  for (const [index, box] of boxes.entries()) {
    const kind = kinds.get(box.id)
    if (!kind) return { panelId: box.id, message: "That panel is not on this dashboard." }
    if (box.x + box.w > GRID.columns) {
      return { panelId: box.id, message: `A panel must fit within the ${GRID.columns} columns of the grid.` }
    }
    const { min } = PANEL_SIZES[kind]
    if (box.w < min.w || box.h < min.h) {
      return {
        panelId: box.id,
        message: `This ${kind} panel must be at least ${min.w} columns wide and ${min.h} row${min.h === 1 ? "" : "s"} tall.`,
      }
    }
    const other = boxes.slice(index + 1).find((candidate) => overlaps(box, candidate))
    if (other) return { panelId: box.id, message: "Panels cannot overlap." }
  }
  return null
}

/**
 * Puts `moved` in place and pushes every box it would overlap further down,
 * top to bottom, so nothing overlaps; boxes out of its way stay where they are.
 */
export function pushDown(boxes: PlacedBox[], moved: PlacedBox): PlacedBox[] {
  const placed: PlacedBox[] = [moved]
  const others = boxes.filter((box) => box.id !== moved.id).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const box of others) {
    let y = box.y
    for (;;) {
      const blocking = placed.filter((other) => overlaps({ ...box, y }, other))
      if (blocking.length === 0) break
      y = Math.max(...blocking.map((other) => other.y + other.h))
    }
    placed.push({ ...box, y })
  }
  return placed
}

/**
 * The layout after a panel changes kind: its box grows to the new kind's
 * minimum (moving left if it would leave the grid) and pushes others down.
 * Null when it already fits.
 */
export function fitKind(boxes: PlacedBox[], id: string, kind: PanelKind): PlacedBox[] | null {
  const box = boxes.find((candidate) => candidate.id === id)
  if (!box) return null
  const { min } = PANEL_SIZES[kind]
  if (box.w >= min.w && box.h >= min.h) return null
  const w = Math.max(box.w, min.w)
  return pushDown(boxes, { ...box, w, h: Math.max(box.h, min.h), x: Math.min(box.x, GRID.columns - w) })
}
