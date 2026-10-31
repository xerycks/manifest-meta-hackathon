import type { WorkspaceRole } from "../../app/organization-role.ts"
import type { ParameterType, ParameterValue, ResolvedParameter, SavedQuery } from "./types.ts"

const RELATIVE_LABELS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  start_of_week: "Start of this week (Monday)",
  start_of_month: "Start of this month",
  start_of_quarter: "Start of this quarter",
  start_of_year: "Start of this year",
}

const plural = (count: number, unit: string) =>
  `${count.toLocaleString("en-US")} ${unit}${count === 1 ? "" : "s"}`

/** "Start of this month", "7 days ago", "3 months ago"; anything else as written. */
export function relativeLabel(value: string): string {
  const known = RELATIVE_LABELS[value]
  if (known) return known
  const counted = /^(days|months)_ago:(\d+)$/.exec(value)
  if (!counted) return value
  const count = Number(counted[2])
  if (count === 0) return "Today"
  return `${plural(count, counted[1] === "days" ? "day" : "month")} ago`
}

/** A resolved date or datetime as people read it: "2026-10-01" or "2026-10-01 09:30:00+05:30". */
export function formatParameterValue(value: string): string {
  return value.replace("T", " ")
}

/** What a default or run value asks for, before it resolves. */
export function describeParameterValue(value: ParameterValue | null): string {
  if (!value) return "No default"
  return value.kind === "relative" ? relativeLabel(value.value) : formatParameterValue(value.value)
}

/** "Start of this month (2026-10-01)", or "No value" for an optional parameter left empty. */
export function describeResolved(parameter: ResolvedParameter): string {
  if (parameter.value === null) return "No value"
  const shown = formatParameterValue(parameter.value)
  return parameter.input?.kind === "relative" ? `${relativeLabel(parameter.input.value)} (${shown})` : shown
}

export const PARAMETER_TYPE_LABELS: Record<ParameterType, string> = {
  date: "Date",
  datetime: "Date and time",
}

/** Mirrors the server: the creator or an owner or admin changes or deletes a saved query. */
export function canChangeSavedQuery(
  savedQuery: Pick<SavedQuery, "createdBy">,
  userId: string | undefined,
  role: WorkspaceRole | null,
): boolean {
  return role === "owner" || role === "admin" || (userId !== undefined && savedQuery.createdBy?.id === userId)
}
