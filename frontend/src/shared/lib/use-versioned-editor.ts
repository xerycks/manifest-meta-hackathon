import { useState } from "react"

import {
  isDirty,
  rebaseDraft,
  staleRecord,
  startDraft,
  takeTheirs,
  withConflict,
  type DraftFields,
  type DraftState,
} from "./draft.ts"

interface VersionedEditorOptions<K extends string, R extends { version: number }, P> {
  initial: DraftFields<K>
  /** What the form starts with when it differs from `initial`, e.g. a prefilled new record. */
  draft?: DraftFields<K>
  version: number
  /** The editor's fields for a newer saved record, as reported by a rejected save. */
  fieldsOf: (record: R) => DraftFields<K>
  toPatch: (state: DraftState<K>) => P
  save: (patch: P) => Promise<unknown>
  onSaved: () => void
}

export interface VersionedEditor<K extends string, R> {
  state: DraftState<K>
  /** The newer saved record while a conflict is unresolved. */
  newer: R | null
  error: unknown
  saving: boolean
  setField: (key: K, value: string) => void
  save: () => Promise<void>
  /** Saves the draft on top of the newer version. */
  keepMine: () => Promise<void>
  takeTheirs: () => void
}

/**
 * Draft, save, and conflict handling for one versioned record. A failed save
 * keeps the draft and exposes the error; a save rejected as stale keeps the
 * draft and exposes the newer record, so the user can put their changes on
 * top of it or take the newer version instead.
 */
export function useVersionedEditor<K extends string, R extends { version: number }, P>(
  options: VersionedEditorOptions<K, R, P>,
): VersionedEditor<K, R> {
  const [state, setState] = useState(() => ({
    ...startDraft(options.initial, options.version),
    draft: options.draft ?? options.initial,
  }))
  const [newer, setNewer] = useState<R | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  async function submit(next: DraftState<K>) {
    setState(next)
    setError(null)
    setNewer(null)
    if (!isDirty(next)) {
      options.onSaved()
      return
    }
    setSaving(true)
    try {
      await options.save(options.toPatch(next))
      options.onSaved()
    } catch (caught) {
      const current = staleRecord<R>(caught)
      if (current) {
        setNewer(current)
        setState(withConflict(next, options.fieldsOf(current), current.version))
      } else {
        setError(caught)
      }
    } finally {
      setSaving(false)
    }
  }

  return {
    state,
    newer,
    error,
    saving,
    setField(key: K, value: string) {
      setState((current) => ({ ...current, draft: { ...current.draft, [key]: value } }))
    },
    save: () => submit(state),
    keepMine: () => submit(rebaseDraft(state)),
    takeTheirs() {
      setState(takeTheirs(state))
      setNewer(null)
    },
  }
}
