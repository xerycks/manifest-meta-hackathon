import {
  GRID,
  PANEL_SIZES,
  type PanelBox,
  type PanelKind,
  type SaveLayoutInput,
} from "../../entities/dashboards/types.ts"

/** A panel's box with what the layout needs to know about the panel. */
export type LayoutItem = PanelBox & { id: string; kind: PanelKind }

/** Grid rows are this tall, and panels this far apart, in pixels. */
export const ROW_HEIGHT = 72
export const GAP = 16
/** Below this canvas width, panels stack in one column and cannot be dragged. */
export const NARROW_WIDTH = 640

export function overlaps(a: PanelBox, b: PanelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Keeps a box on the grid, at least its kind's minimum size, and no larger than the grid allows. */
export function clampBox(box: PanelBox, kind: PanelKind): PanelBox {
  const { min } = PANEL_SIZES[kind]
  const w = Math.min(GRID.columns, Math.max(min.w, box.w))
  const h = Math.min(GRID.maxHeight, Math.max(min.h, box.h))
  return {
    x: Math.min(GRID.columns - w, Math.max(0, box.x)),
    y: Math.min(GRID.maxRow, Math.max(0, box.y)),
    w,
    h,
  }
}

/** Puts `moved` in place and pushes every box it would overlap further down, top to bottom. */
function pushDown(items: LayoutItem[], moved: LayoutItem): LayoutItem[] {
  const placed: LayoutItem[] = [moved]
  const others = items.filter((item) => item.id !== moved.id).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const item of others) {
    let y = item.y
    for (;;) {
      const blocking = placed.filter((other) => overlaps({ ...item, y }, other))
      if (blocking.length === 0) break
      y = Math.max(...blocking.map((other) => other.y + other.h))
    }
    placed.push({ ...item, y })
  }
  return placed
}

/**
 * Floats every box up to the highest free row at or above it, top to bottom,
 * so the layout has no gaps above a panel; `pinned` (the panel being moved)
 * stays where it is, and a box may rise past it into the room it left.
 */
export function compact(items: LayoutItem[], pinned?: string): LayoutItem[] {
  const placed = items.filter((item) => item.id === pinned)
  const others = items.filter((item) => item.id !== pinned).sort((a, b) => a.y - b.y || a.x - b.x)
  for (const item of others) {
    let y = 0
    while (y < item.y && placed.some((other) => overlaps({ ...item, y }, other))) y += 1
    placed.push({ ...item, y })
  }
  const byId = new Map(placed.map((item) => [item.id, item]))
  return items.map((item) => byId.get(item.id) ?? item)
}

/**
 * Moves or resizes one panel to `target` (kept on the grid and at least its
 * kind's minimum): panels it lands on are pushed down, then the others float
 * up into any gap, the moved panel held where it was put.
 */
export function arrange(items: LayoutItem[], id: string, target: PanelBox): LayoutItem[] {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) return items
  const moved = { ...item, ...clampBox(target, item.kind) }
  const pushed = new Map(pushDown(items, moved).map((placed) => [placed.id, placed]))
  return compact(
    items.map((candidate) => pushed.get(candidate.id) ?? candidate),
    id,
  )
}

/** Panels top to bottom, then left to right: the order a narrow screen stacks them in. */
export function stackOrder<T extends { id: string; layout: PanelBox }>(panels: T[]): T[] {
  return [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
}

const STEPS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

/** One keyboard step: an arrow key moves the box one cell; with Shift it resizes it. Null for other keys. */
export function keyboardStep(box: PanelBox, key: string, resize: boolean): PanelBox | null {
  const step = STEPS[key]
  if (!step) return null
  const [dx, dy] = step
  return resize ? { ...box, w: box.w + dx, h: box.h + dy } : { ...box, x: box.x + dx, y: box.y + dy }
}

/** A pointer movement in pixels as whole grid cells, for a canvas `width` pixels wide. */
export function gridDelta(dx: number, dy: number, width: number): { columns: number; rows: number } {
  const column = (width - GAP * (GRID.columns - 1)) / GRID.columns + GAP
  // `|| 0` turns a rounded -0 into 0.
  return { columns: Math.round(dx / column) || 0, rows: Math.round(dy / (ROW_HEIGHT + GAP)) || 0 }
}

export function sameLayout(a: LayoutItem[], b: LayoutItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item) => {
      const other = b.find((candidate) => candidate.id === item.id)
      return other && other.x === item.x && other.y === item.y && other.w === item.w && other.h === item.h
    })
  )
}

/** What the layout route saves: every panel's box, based on the layout version the page read. */
export function layoutInput(items: LayoutItem[], version: number): SaveLayoutInput {
  return { version, boxes: items.map(({ id, x, y, w, h }) => ({ panelId: id, x, y, w, h })) }
}

/** "Column 3, row 2, 6 columns wide, 4 rows tall", for announcing a keyboard move. */
export function describeBox(box: PanelBox): string {
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`
  return `Column ${box.x + 1}, row ${box.y + 1}, ${plural(box.w, "column")} wide, ${plural(box.h, "row")} tall`
}
