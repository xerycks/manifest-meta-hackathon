import { GripVertical } from "lucide-react"
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react"

import { useSaveLayout } from "@/entities/dashboards/api.ts"
import { PANEL_KIND_LABELS, panelTitle } from "@/entities/dashboards/panel-config.ts"
import type { DashboardDetail, DashboardPanel, PanelBox } from "@/entities/dashboards/types.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { cn } from "@/shared/lib/cn.ts"
import { useElementWidth } from "@/shared/lib/use-element-width.ts"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import {
  arrange,
  describeBox,
  GAP,
  gridDelta,
  keyboardStep,
  layoutInput,
  NARROW_WIDTH,
  ROW_HEIGHT,
  sameLayout,
  stackOrder,
  type LayoutItem,
} from "./layout.ts"

/** Keyboard moves are saved once the keys have rested this long. */
const KEYBOARD_SAVE_MS = 700
/** A handle that lost focus this soon after a keyboard move (its panel moved in the page) gets it back. */
const REFOCUS_MS = 5_000

interface Drag {
  id: string
  mode: "move" | "resize"
  pointerId: number
  startX: number
  startY: number
  origin: PanelBox
  base: LayoutItem[]
}

const itemsOf = (panels: DashboardPanel[]): LayoutItem[] =>
  panels.map((panel) => ({ id: panel.id, kind: panel.kind, ...panel.layout }))

const heightOf = (rows: number) => rows * ROW_HEIGHT + (rows - 1) * GAP

function panelLabel(panel: DashboardPanel): string {
  const savedQuery = panel.data?.state === "available" ? panel.data.savedQuery.name : null
  return panelTitle(panel.title, savedQuery) || `${PANEL_KIND_LABELS[panel.kind]} panel`
}

/**
 * The dashboard's panels on a 12-column grid. Editors move a panel by
 * dragging its handle and resize it from its corner, or focus the handle and
 * use the arrow keys (with Shift to resize); panels in the way move down and
 * gaps close up. Each change is saved as a whole layout. On a narrow canvas
 * the panels stack in one column, top to bottom then left to right, and do
 * not move.
 */
export function DashboardCanvas({
  workspaceId,
  dashboard,
  canEdit,
  renderPanel,
}: {
  workspaceId: string
  dashboard: DashboardDetail
  canEdit: boolean
  renderPanel: (panel: DashboardPanel, moveHandle: ReactNode) => ReactNode
}) {
  const instructionsId = useId()
  const canvas = useRef<HTMLDivElement>(null)
  const width = useElementWidth(canvas)
  const narrow = width > 0 && width < NARROW_WIDTH
  const save = useSaveLayout(workspaceId, dashboard.id)
  const [draft, setDraft] = useState<LayoutItem[] | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const [dragging, setDragging] = useState<string | null>(null)
  const drag = useRef<Drag | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const saving = useRef(false)
  // The handle last moved with the keys, refocused if saving moves its panel in the page order.
  const keyed = useRef<{ id: string; at: number } | null>(null)

  const server = itemsOf(dashboard.panels)
  const items = draft ?? server
  const byId = new Map(items.map((item) => [item.id, item]))
  const movable = canEdit && !narrow

  // A newer dashboard (saved, or reread after a conflict) replaces the local layout.
  useEffect(() => {
    if (!drag.current && timer.current === undefined && !saving.current) setDraft(null)
  }, [dashboard])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  useLayoutEffect(() => {
    const last = keyed.current
    const lost = !document.activeElement || document.activeElement === document.body
    if (!last || !lost || Date.now() - last.at > REFOCUS_MS || !canvas.current) return
    canvas.current.querySelector<HTMLElement>(`[data-panel-handle="${last.id}"]`)?.focus()
  }, [dashboard.panels])

  function persist(next: LayoutItem[]) {
    window.clearTimeout(timer.current)
    timer.current = undefined
    if (sameLayout(next, server)) {
      setDraft(null)
      return
    }
    saving.current = true
    save.mutate(layoutInput(next, dashboard.layoutVersion), {
      onSuccess: () => setAnnouncement("Layout saved."),
      onError: () => setAnnouncement("The layout was not saved."),
      onSettled: () => {
        saving.current = false
        setDraft(null)
      },
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, item: LayoutItem) {
    if (event.key === "Escape" && timer.current !== undefined) {
      window.clearTimeout(timer.current)
      timer.current = undefined
      setDraft(null)
      setAnnouncement("Move undone.")
      return
    }
    const target = keyboardStep(item, event.key, event.shiftKey)
    if (!target) return
    event.preventDefault()
    if (saving.current) {
      setAnnouncement("Saving the layout; try again in a moment.")
      return
    }
    const next = arrange(items, item.id, target)
    const moved = next.find((candidate) => candidate.id === item.id) ?? item
    keyed.current = { id: item.id, at: Date.now() }
    setDraft(next)
    setAnnouncement(describeBox(moved))
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => persist(next), KEYBOARD_SAVE_MS)
  }

  function startDrag(event: PointerEvent<HTMLElement>, item: LayoutItem, mode: Drag["mode"]) {
    if (event.button !== 0 || saving.current || timer.current !== undefined) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      id: item.id,
      mode,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: item,
      base: items,
    }
    setDragging(item.id)
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    const { columns, rows } = gridDelta(event.clientX - current.startX, event.clientY - current.startY, width)
    const { origin } = current
    const target =
      current.mode === "move"
        ? { ...origin, x: origin.x + columns, y: origin.y + rows }
        : { ...origin, w: origin.w + columns, h: origin.h + rows }
    setDraft(arrange(current.base, current.id, target))
  }

  function endDrag(event: PointerEvent<HTMLElement>, cancelled: boolean) {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(null)
    if (cancelled || !draft) setDraft(null)
    else persist(draft)
  }

  const handle = (panel: DashboardPanel, item: LayoutItem) => (
    <button
      type="button"
      data-panel-handle={panel.id}
      aria-label={`Move or resize ${panelLabel(panel)}`}
      aria-describedby={instructionsId}
      title="Drag to move; arrow keys move, Shift and arrow keys resize"
      className="-ml-1 shrink-0 cursor-grab touch-none rounded p-1 text-(--muted) hover:bg-(--surface) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) active:cursor-grabbing"
      onKeyDown={(event) => onKeyDown(event, item)}
      onBlur={() => {
        // Leaving the handle saves a keyboard move right away.
        if (timer.current !== undefined && draft) persist(draft)
      }}
      onPointerDown={(event) => startDrag(event, item, "move")}
      onPointerMove={moveDrag}
      onPointerUp={(event) => endDrag(event, false)}
      onPointerCancel={(event) => endDrag(event, true)}
    >
      <GripVertical aria-hidden className="size-4" />
    </button>
  )

  return (
    <div ref={canvas} className="min-w-0">
      <p id={instructionsId} className="sr-only">
        Arrow keys move the panel one cell; Shift with the arrow keys resizes it. Panels in the way move down.
        The layout is saved when you stop; Escape undoes a move that is not saved yet.
      </p>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {save.error && (
        <div className="mb-3">
          <FailureNotice
            title="Layout not saved"
            message={`${apiErrorMessage(save.error)} The dashboard now shows the current layout.`}
          />
        </div>
      )}
      {narrow ? (
        <ol aria-label="Panels" className="flex flex-col gap-4">
          {stackOrder(dashboard.panels).map((panel) => (
            <li key={panel.id} className="min-w-0" style={{ height: heightOf(panel.layout.h) }}>
              {renderPanel(panel, null)}
            </li>
          ))}
        </ol>
      ) : (
        <ol
          aria-label="Panels"
          className="grid"
          style={{
            gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
            gridAutoRows: `${ROW_HEIGHT}px`,
            gap: `${GAP}px`,
          }}
        >
          {/* Page order follows the saved layout, so focus and dragging keep their element. */}
          {dashboard.panels.map((panel) => {
            const item = byId.get(panel.id) ?? { id: panel.id, kind: panel.kind, ...panel.layout }
            return (
              <li
                key={panel.id}
                className={cn(
                  "relative min-w-0 rounded-lg has-[[data-panel-handle]:focus-visible]:outline-2 has-[[data-panel-handle]:focus-visible]:outline-offset-2 has-[[data-panel-handle]:focus-visible]:outline-(--accent)",
                  dragging === panel.id && "z-10 shadow-lg",
                )}
                style={{
                  gridColumn: `${item.x + 1} / span ${item.w}`,
                  gridRow: `${item.y + 1} / span ${item.h}`,
                }}
              >
                {renderPanel(panel, movable ? handle(panel, item) : null)}
                {movable && (
                  // Pointer resizing; keyboard users resize with Shift and the arrow keys on the handle.
                  <span
                    aria-hidden
                    className="absolute right-0.5 bottom-0.5 size-4 cursor-se-resize touch-none rounded-br-lg border-r-2 border-b-2 border-(--chart-axis) hover:border-(--accent)"
                    onPointerDown={(event) => startDrag(event, item, "resize")}
                    onPointerMove={moveDrag}
                    onPointerUp={(event) => endDrag(event, false)}
                    onPointerCancel={(event) => endDrag(event, true)}
                  />
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
