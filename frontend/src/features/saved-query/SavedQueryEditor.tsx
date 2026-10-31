import { useId, useRef, useState } from "react"

import type { ConnectionEngine } from "@/entities/connections/types.ts"
import { useCreateSavedQuery, useUpdateSavedQuery } from "@/entities/saved-queries/api.ts"
import {
  SAVED_QUERY_LIMITS,
  type CreateSavedQueryInput,
  type SavedQueryDetail,
  type UpdateSavedQueryInput,
} from "@/entities/saved-queries/types.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage, theirChanges, type DraftState } from "@/shared/lib/draft.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { ConflictNotice, type ConflictField } from "@/shared/ui/conflict-notice.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Textarea } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"

import { ParametersEditor } from "./ParametersEditor.tsx"
import {
  createInput,
  EMPTY_FIELDS,
  parametersSummary,
  parametersText,
  parseParameterDrafts,
  savedQueryFields,
  updatePatch,
  type FormErrors,
  type SavedQueryField,
  type SavePrefill,
} from "./saved-query-form.ts"

const SQL_HINT =
  "One read-only SELECT. Put {{name}} where a parameter's date goes, e.g. WHERE ordered_at >= {{since}}. Against timestamp columns, use Date and time parameters: they carry the workspace time zone."
const MONGO_HINT =
  'JSON with database, collection, operation ("find" or "aggregate"), and a filter or pipeline. Put {"$param": "name"} where a parameter\'s date goes.'

const CONFLICT_LABELS: Record<SavedQueryField, string> = {
  name: "Name",
  description: "Description",
  query: "Query",
  parameters: "Parameters",
  visibility: "Visibility",
}

/**
 * Creates a saved query (from an answer's evidence or the query console) or
 * edits one. The server checks the query with the source's validators before
 * saving. A failed save keeps everything typed; a save rejected as stale shows
 * the newer version next to the draft.
 */
export function SavedQueryEditor({
  workspaceId,
  engine,
  sourceName,
  target,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  engine: ConnectionEngine
  sourceName: string
  /** A new saved query with what it starts from, or the one to edit. */
  target: { kind: "create"; prefill: SavePrefill } | { kind: "edit"; savedQuery: SavedQueryDetail }
  onSaved: (saved: SavedQueryDetail) => void
  onCancel: () => void
}) {
  const id = useId()
  const context = useSessionContext()
  const nameInput = useRef<HTMLInputElement>(null)
  const saved = useRef<SavedQueryDetail | null>(null)
  const [errors, setErrors] = useState<FormErrors>({})
  const create = useCreateSavedQuery(workspaceId)
  const update = useUpdateSavedQuery(workspaceId, target.kind === "edit" ? target.savedQuery.id : "")
  const editing = target.kind === "edit" ? target.savedQuery : null
  const buildFor = (state: DraftState<SavedQueryField>) =>
    target.kind === "create" ? createInput(state.draft, target.prefill, engine) : updatePatch(state, engine)

  const editor = useVersionedEditor<
    SavedQueryField,
    SavedQueryDetail,
    CreateSavedQueryInput | UpdateSavedQueryInput
  >({
    // A new saved query starts from nothing, so a prefilled form still counts as a change.
    initial: editing ? savedQueryFields(editing) : EMPTY_FIELDS,
    ...(target.kind === "create" ? { draft: target.prefill.fields } : {}),
    version: editing?.version ?? 1,
    fieldsOf: savedQueryFields,
    toPatch: (state) => {
      const built = buildFor(state)
      if ("errors" in built) throw new Error("The form has problems to fix first")
      return "input" in built ? built.input : built.patch
    },
    save: async (payload) => {
      saved.current = editing
        ? await update.mutateAsync(payload as UpdateSavedQueryInput)
        : await create.mutateAsync(payload as CreateSavedQueryInput)
    },
    onSaved: () => (saved.current ? onSaved(saved.current) : onCancel()),
  })
  const { draft } = editor.state
  const drafts = parseParameterDrafts(draft.parameters)

  function submit() {
    const built = buildFor(editor.state)
    const problems = "errors" in built ? built.errors : {}
    setErrors(problems)
    if (problems.name) nameInput.current?.focus()
    if ("errors" in built) return
    void (editor.state.conflict ? editor.keepMine() : editor.save())
  }

  const newer = editor.newer
  const conflict: ConflictField[] = newer
    ? theirChanges(editor.state).map((key) => {
        const theirs = savedQueryFields(newer)[key]
        if (key === "description") return { label: CONFLICT_LABELS[key], value: theirs, markdown: true }
        if (key === "parameters") return { label: CONFLICT_LABELS[key], value: parametersSummary(theirs) }
        if (key === "visibility") {
          const value = theirs === "private" ? "Only its creator" : "Everyone"
          return { label: CONFLICT_LABELS[key], value }
        }
        return { label: CONFLICT_LABELS[key], value: theirs }
      })
    : []
  const queryHint = engine === "postgres" ? SQL_HINT : MONGO_HINT
  // An owner or admin editing someone else's saved query makes it private to its creator.
  const creator = editing?.createdBy
  const mine = !editing || (creator !== null && creator?.id === context.data?.user.id)
  const visibility = [
    { value: "workspace", label: "Everyone in the workspace" },
    { value: "private", label: mine ? "Only me" : `Only its creator${creator ? ` (${creator.name})` : ""}` },
  ]

  return (
    <form
      aria-label={editing ? `Edit ${editing.name}` : "Save as query"}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <p className="text-sm text-(--muted)">
        Source: <span className="font-medium text-(--foreground)">{sourceName}</span>
      </p>
      <Field id={`${id}-name`} label="Name" error={errors.name}>
        <Input
          ref={nameInput}
          {...described(`${id}-name`, errors.name)}
          value={draft.name}
          maxLength={SAVED_QUERY_LIMITS.nameChars}
          placeholder="e.g. Monthly net revenue"
          autoFocus
          onChange={(event) => editor.setField("name", event.target.value)}
        />
      </Field>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-description`} className="text-sm font-medium">
          Description (optional)
        </label>
        <MarkdownEditor
          id={`${id}-description`}
          value={draft.description}
          onChange={(value) => editor.setField("description", value)}
          maxLength={SAVED_QUERY_LIMITS.descriptionChars}
          rows={4}
          placeholder="What it answers, and how to read the result…"
        />
      </div>
      <Field
        id={`${id}-query`}
        label={engine === "postgres" ? "SQL" : "Query (JSON)"}
        error={errors.query}
        hint={queryHint}
      >
        <Textarea
          {...described(`${id}-query`, errors.query, queryHint)}
          value={draft.query}
          rows={10}
          spellCheck={false}
          className="font-mono text-xs leading-5"
          onChange={(event) => editor.setField("query", event.target.value)}
        />
      </Field>
      <ParametersEditor
        drafts={drafts}
        errors={errors.parameters}
        engine={engine}
        onChange={(next) => editor.setField("parameters", parametersText(next))}
      />
      <Choice
        label="Who can see and run it"
        value={draft.visibility}
        options={visibility}
        onChange={(visibility) => editor.setField("visibility", visibility)}
      />

      {editor.error !== null && <FailureNotice title="Not saved" message={apiErrorMessage(editor.error)} />}
      {editor.state.conflict && (
        <ConflictNotice
          by={newer?.updatedBy?.name ?? null}
          at={newer?.updatedAt ?? null}
          fields={conflict}
          saving={editor.saving}
          onKeepMine={submit}
          onTakeTheirs={editor.takeTheirs}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {!editor.state.conflict && (
          <Button type="submit" disabled={editor.saving}>
            {editor.saving ? "Saving…" : editing ? "Save changes" : "Save query"}
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={editor.saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
