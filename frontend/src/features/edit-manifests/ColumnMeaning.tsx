import { Pencil } from "lucide-react"

import { useUpdateColumn } from "@/entities/manifests/api.ts"
import type { ColumnPatch, ManifestColumn } from "@/entities/manifests/types.ts"
import { draftPatch, fieldsOf } from "@/shared/lib/draft.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"

import { MeaningForm } from "./MeaningForm.tsx"
import { COLUMN_FIELDS, COLUMN_KEYS, hasColumnMeaning } from "./meaning-fields.ts"
import { EditedBy } from "./ObjectMeaning.tsx"

/** A column's authored meaning in its table row, with an edit button for owners and admins. */
export function ColumnMeaningSummary({
  column,
  canEdit,
  editorOpen,
  onEdit,
}: {
  column: ManifestColumn
  canEdit: boolean
  /** One column is edited at a time, so a draft is never dropped by opening another. */
  editorOpen: boolean
  onEdit: () => void
}) {
  const described = hasColumnMeaning(column)
  return (
    <div className="max-w-sm space-y-1">
      {column.label && <p className="font-medium break-words">{column.label}</p>}
      {column.unit && <Badge>Unit: {column.unit}</Badge>}
      {column.description && <Markdown>{column.description}</Markdown>}
      {column.valueNotes && (
        <p className="text-xs leading-5 break-words whitespace-pre-wrap text-(--muted)">
          Values: {column.valueNotes}
        </p>
      )}
      {canEdit && !editorOpen && (
        <Button
          variant="ghost"
          className="-ml-2 px-2 py-0.5 text-xs"
          aria-label={`${described ? "Edit" : "Add"} meaning of ${column.name}`}
          onClick={onEdit}
        >
          <Pencil aria-hidden className="size-3" />
          {described ? "Edit" : "Add meaning"}
        </Button>
      )}
    </div>
  )
}

/** The inline editor for one column, shown in a full-width row under it. */
export function ColumnMeaningEditor({
  workspaceId,
  connectionId,
  column,
  onClose,
}: {
  workspaceId: string
  connectionId: string
  column: ManifestColumn
  onClose: () => void
}) {
  const update = useUpdateColumn(workspaceId, connectionId)
  const editor = useVersionedEditor({
    initial: fieldsOf(column, COLUMN_KEYS),
    version: column.version,
    fieldsOf: (current: ManifestColumn) => fieldsOf(current, COLUMN_KEYS),
    toPatch: (state): ColumnPatch => draftPatch(state),
    save: (patch) => update.mutateAsync({ columnId: column.id, patch }),
    onSaved: onClose,
  })
  return (
    <div className="space-y-2">
      <MeaningForm
        title={`Meaning of ${column.name}`}
        fields={COLUMN_FIELDS}
        editor={editor}
        newerBy={editor.newer?.editedBy?.name ?? null}
        newerAt={editor.newer?.editedAt ?? null}
        onCancel={onClose}
      />
      <EditedBy by={column.editedBy} at={column.editedAt} />
    </div>
  )
}
