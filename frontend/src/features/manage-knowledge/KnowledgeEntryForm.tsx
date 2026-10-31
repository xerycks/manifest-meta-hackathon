import { useId, useRef, useState } from "react"

import { useConnections } from "@/entities/connections/api.ts"
import { useCreateKnowledgeEntry, useUpdateKnowledgeEntry } from "@/entities/knowledge/api.ts"
import type {
  CreateKnowledgeEntryInput,
  KnowledgeEntry,
  UpdateKnowledgeEntryInput,
} from "@/entities/knowledge/types.ts"
import { apiErrorMessage, theirChanges } from "@/shared/lib/draft.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { ConflictNotice, type ConflictField } from "@/shared/ui/conflict-notice.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Label, Select } from "@/shared/ui/fields.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"

import {
  BODY_MAX,
  EMPTY_ENTRY,
  entryFields,
  entryPatch,
  newEntry,
  TITLE_MAX,
  titleProblem,
  type KnowledgeField,
} from "./knowledge-form.ts"

/**
 * Creates or edits a knowledge entry. A failed save keeps everything typed and
 * shows why; a save rejected as stale shows the newer version next to the draft.
 */
export function KnowledgeEntryForm({
  workspaceId,
  entry,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  /** The entry to edit, or null to add one. */
  entry: KnowledgeEntry | null
  onSaved: (entry: KnowledgeEntry) => void
  onCancel: () => void
}) {
  const id = useId()
  const titleInput = useRef<HTMLInputElement>(null)
  const saved = useRef<KnowledgeEntry | null>(null)
  const [titleError, setTitleError] = useState<string | null>(null)
  const connections = useConnections(workspaceId)
  const create = useCreateKnowledgeEntry(workspaceId)
  const update = useUpdateKnowledgeEntry(workspaceId, entry?.id ?? "")

  const editor = useVersionedEditor<
    KnowledgeField,
    KnowledgeEntry,
    CreateKnowledgeEntryInput | UpdateKnowledgeEntryInput
  >({
    initial: entry ? entryFields(entry) : EMPTY_ENTRY,
    version: entry?.version ?? 1,
    fieldsOf: entryFields,
    toPatch: (state) => (entry ? entryPatch(state) : newEntry(state.draft)),
    save: async (payload) => {
      saved.current = entry
        ? await update.mutateAsync(payload as UpdateKnowledgeEntryInput)
        : await create.mutateAsync(payload as CreateKnowledgeEntryInput)
    },
    // Nothing changed: closing the editor is the whole save.
    onSaved: () => (saved.current ? onSaved(saved.current) : onCancel()),
  })
  const { draft } = editor.state

  function submit() {
    const problem = titleProblem(draft.title)
    setTitleError(problem)
    if (problem) {
      titleInput.current?.focus()
      return
    }
    void (editor.state.conflict ? editor.keepMine() : editor.save())
  }

  const newer = editor.newer
  const conflict: ConflictField[] = newer
    ? theirChanges(editor.state).map((key) =>
        key === "title"
          ? { label: "Title", value: newer.title }
          : key === "body"
            ? { label: "Definition", value: newer.body, markdown: true }
            : { label: "Source", value: newer.connection?.name ?? "No source" },
      )
    : []

  return (
    <form
      aria-label={entry ? `Edit ${entry.title}` : "New knowledge entry"}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${id}-title`}>Term</Label>
        <Input
          ref={titleInput}
          id={`${id}-title`}
          value={draft.title}
          maxLength={TITLE_MAX}
          placeholder="e.g. Active customer"
          autoFocus
          aria-invalid={titleError !== null}
          aria-describedby={titleError ? `${id}-title-error` : undefined}
          onChange={(event) => editor.setField("title", event.target.value)}
        />
        {titleError && (
          <p id={`${id}-title-error`} className="text-sm text-(--danger)">
            {titleError}
          </p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-source`}>Source (optional)</Label>
        <Select
          id={`${id}-source`}
          value={draft.connectionId}
          disabled={!connections.data}
          onChange={(event) => editor.setField("connectionId", event.target.value)}
        >
          <option value="">Not about one source</option>
          {connections.data?.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </Select>
        {connections.isError && (
          <p className="text-sm text-(--muted)">Sources could not be loaded, so none can be linked.</p>
        )}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-body`}>Definition</Label>
        <MarkdownEditor
          id={`${id}-body`}
          value={draft.body}
          onChange={(value) => editor.setField("body", value)}
          maxLength={BODY_MAX}
          rows={12}
          placeholder="How the business defines it, how to calculate it, and which tables and columns hold it…"
        />
      </div>

      {editor.error !== null && (
        <FailureNotice title="Not saved" message={apiErrorMessage(editor.error)} />
      )}
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
            {editor.saving ? "Saving…" : entry ? "Save" : "Add entry"}
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={editor.saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
