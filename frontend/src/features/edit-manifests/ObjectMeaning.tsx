import { Pencil } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { useUpdateObject } from "@/entities/manifests/api.ts"
import type { Author, ManifestObject, ObjectPatch } from "@/entities/manifests/types.ts"
import { draftPatch, fieldsOf } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Markdown } from "@/shared/ui/markdown.tsx"

import { MeaningForm } from "./MeaningForm.tsx"
import { OBJECT_FIELDS, OBJECT_KEYS } from "./meaning-fields.ts"

export function EditedBy({ by, at }: { by: Author | null; at: string | null }) {
  if (!at) return null
  return (
    <p className="text-xs text-(--muted)">
      Edited{by && ` by ${by.name}`}{" "}
      <time dateTime={at} title={new Date(at).toLocaleString()}>
        {formatRelativeTime(at)}
      </time>
    </p>
  )
}

function ObjectMeaningForm({
  workspaceId,
  connectionId,
  object,
  onClose,
}: {
  workspaceId: string
  connectionId: string
  object: ManifestObject
  onClose: () => void
}) {
  const update = useUpdateObject(workspaceId, connectionId)
  const editor = useVersionedEditor({
    initial: fieldsOf(object, OBJECT_KEYS),
    version: object.version,
    fieldsOf: (current: ManifestObject) => fieldsOf(current, OBJECT_KEYS),
    toPatch: (state): ObjectPatch => draftPatch(state),
    save: (patch) => update.mutateAsync({ objectId: object.id, patch }),
    onSaved: onClose,
  })
  return (
    <MeaningForm
      title={`Business context for ${object.schema}.${object.name}`}
      fields={OBJECT_FIELDS}
      editor={editor}
      newerBy={editor.newer?.editedBy?.name ?? null}
      newerAt={editor.newer?.editedAt ?? null}
      onCancel={onClose}
    />
  )
}

/**
 * What a table or view means in business terms: label, what one row is, and a
 * Markdown description. Owners and admins edit it in place.
 */
export function ObjectMeaning({
  workspaceId,
  connectionId,
  object,
  canEdit,
}: {
  workspaceId: string
  connectionId: string
  object: ManifestObject
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef(false)
  const empty = !object.label && !object.rowMeaning && !object.description

  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false
      editButton.current?.focus()
    }
  }, [editing])

  if (editing) {
    return (
      <ObjectMeaningForm
        workspaceId={workspaceId}
        connectionId={connectionId}
        object={object}
        onClose={() => {
          returnFocus.current = true
          setEditing(false)
        }}
      />
    )
  }

  return (
    <section aria-label="Business context" className="space-y-2 rounded-lg border border-(--border) p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">Business context</h3>
        {canEdit && (
          <Button
            ref={editButton}
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            onClick={() => setEditing(true)}
          >
            <Pencil aria-hidden className="size-3.5" />
            {empty ? "Add context" : "Edit"}
          </Button>
        )}
      </div>
      {empty ? (
        <p className="text-sm text-(--muted)">
          {canEdit
            ? "No one has described this yet. Add a label, what one row represents, and what the data means."
            : "No one has described this yet. Owners and admins can add business context."}
        </p>
      ) : (
        <>
          {(object.label || object.rowMeaning) && (
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              {object.label && (
                <>
                  <dt className="text-(--muted)">Label</dt>
                  <dd className="font-medium break-words">{object.label}</dd>
                </>
              )}
              {object.rowMeaning && (
                <>
                  <dt className="text-(--muted)">Each row is</dt>
                  <dd className="break-words">{object.rowMeaning}</dd>
                </>
              )}
            </dl>
          )}
          {object.description && <Markdown className="max-w-3xl">{object.description}</Markdown>}
          <EditedBy by={object.editedBy} at={object.editedAt} />
        </>
      )}
    </section>
  )
}
