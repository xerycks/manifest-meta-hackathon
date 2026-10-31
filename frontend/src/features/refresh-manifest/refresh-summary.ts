import type {
  ManifestRefresh,
  RefreshCounts,
  RefreshPhase,
} from "../../entities/manifests/types.ts"

export const PHASE_LABELS: Record<RefreshPhase, string> = {
  connecting: "Connecting to the source",
  reading_objects: "Reading tables and views",
  reading_columns: "Reading columns",
  reading_relationships: "Reading relationships",
  publishing: "Publishing",
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`
}

const objects = (count: number) => plural(count, "table or view", "tables and views")
const columns = (count: number) => plural(count, "column", "columns")

export interface RefreshProgress {
  label: string
  /** e.g. "200 of 412 tables and views", once the total is known. */
  detail: string | null
  value: number | null
  max: number | null
}

export function refreshProgress(refresh: ManifestRefresh): RefreshProgress {
  if (refresh.status === "queued") {
    return { label: "Waiting to start", detail: null, value: null, max: null }
  }
  const label = refresh.phase ? PHASE_LABELS[refresh.phase] : "Starting"
  const total = refresh.objectsTotal
  if (total === null || total === 0) return { label, detail: null, value: null, max: null }
  const done = Math.min(refresh.objectsDone, total)
  return {
    label,
    detail: `${done.toLocaleString("en-US")} of ${objects(total)}`,
    value: done,
    max: total,
  }
}

/** "6 tables and views · 52 columns · 6 relationships" */
export function describeCounts(counts: RefreshCounts): string {
  return [
    objects(counts.objects),
    columns(counts.columns),
    plural(counts.relationships, "relationship", "relationships"),
  ].join(" · ")
}

/** What changed since the previous refresh, or null when nothing did (or everything is new). */
export function describeChanges(counts: RefreshCounts): string | null {
  const firstDiscovery =
    counts.objectsAdded === counts.objects &&
    counts.objectsRemoved === 0 &&
    counts.columnsRemoved === 0
  if (firstDiscovery) return null
  const parts = [
    counts.objectsAdded > 0 && `${objects(counts.objectsAdded)} added`,
    counts.objectsRemoved > 0 && `${objects(counts.objectsRemoved)} removed`,
    counts.columnsAdded > 0 && `${columns(counts.columnsAdded)} added`,
    counts.columnsRemoved > 0 && `${columns(counts.columnsRemoved)} removed`,
  ].filter((part): part is string => typeof part === "string")
  return parts.length > 0 ? parts.join(", ") : null
}
