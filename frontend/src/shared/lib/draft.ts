import { ApiError } from "../api/client.ts"

/** A record's editable text fields as an editor holds them ("" for empty). */
export type DraftFields<K extends string> = Record<K, string>

/**
 * An editor's state for a versioned record. `base` is what the draft started
 * from and `version` is sent with the save, so a save based on an outdated
 * version is rejected instead of silently overwriting someone else's edit.
 */
export interface DraftState<K extends string> {
  base: DraftFields<K>
  version: number
  draft: DraftFields<K>
  /** A newer saved version reported by a rejected save; the draft is kept. */
  conflict: { fields: DraftFields<K>; version: number } | null
}

export function fieldsOf<K extends string>(
  record: { [P in K]: string | null },
  keys: readonly K[],
): DraftFields<K> {
  const fields = {} as DraftFields<K>
  for (const key of keys) fields[key] = record[key] ?? ""
  return fields
}

export function startDraft<K extends string>(base: DraftFields<K>, version: number): DraftState<K> {
  return { base, version, draft: base, conflict: null }
}

export function changedKeys<K extends string>(from: DraftFields<K>, to: DraftFields<K>): K[] {
  return (Object.keys(from) as K[]).filter((key) => from[key] !== to[key])
}

export function isDirty<K extends string>(state: DraftState<K>): boolean {
  return changedKeys(state.base, state.draft).length > 0
}

/** The save request: only the fields the user changed, with blank values sent as null. */
export function draftPatch<K extends string>(
  state: DraftState<K>,
): { version: number } & Partial<Record<K, string | null>> {
  const changes: Partial<Record<K, string | null>> = {}
  for (const key of changedKeys(state.base, state.draft)) {
    const value = state.draft[key]
    changes[key] = value.trim() === "" ? null : value
  }
  return { version: state.version, ...changes }
}

/** A save was rejected as stale: remember the newer version and keep the draft as it is. */
export function withConflict<K extends string>(
  state: DraftState<K>,
  fields: DraftFields<K>,
  version: number,
): DraftState<K> {
  return { ...state, conflict: { fields, version } }
}

/** Fields the other person changed since this editor opened. */
export function theirChanges<K extends string>(state: DraftState<K>): K[] {
  return state.conflict ? changedKeys(state.base, state.conflict.fields) : []
}

/**
 * Keeps the user's draft on top of the newer version: fields the user changed
 * keep their draft value, every other field takes the newer saved value, and
 * the next save is based on the newer version.
 */
export function rebaseDraft<K extends string>(state: DraftState<K>): DraftState<K> {
  if (!state.conflict) return state
  const theirs = state.conflict.fields
  const draft = { ...theirs }
  for (const key of changedKeys(state.base, state.draft)) draft[key] = state.draft[key]
  return { base: theirs, version: state.conflict.version, draft, conflict: null }
}

/** Drops the draft in favour of the newer saved version. */
export function takeTheirs<K extends string>(state: DraftState<K>): DraftState<K> {
  if (!state.conflict) return state
  const theirs = state.conflict.fields
  return { base: theirs, version: state.conflict.version, draft: theirs, conflict: null }
}

/** The current record a 409 response carries when a save was based on an old version. */
export function staleRecord<T>(error: unknown): T | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null
  const details = error.details
  if (typeof details !== "object" || details === null || !("current" in details)) return null
  return (details as { current: T }).current
}

/** What to tell the user about a failed request: validation issues spelled out, else the server's message. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const issues = (error.details as { issues?: { message?: unknown }[] } | null | undefined)?.issues
    const messages = Array.isArray(issues)
      ? issues.map((issue) => issue.message).filter((message) => typeof message === "string")
      : []
    if (error.code === "VALIDATION_FAILED" && messages.length > 0) return messages.join(". ")
    return error.message
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again."
}
