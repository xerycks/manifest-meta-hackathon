import { useId } from "react"

import {
  useCreateRelationship,
  useManifest,
  useManifestObject,
  useUpdateRelationship,
} from "@/entities/manifests/api.ts"
import type {
  CreateRelationshipInput,
  ManifestColumn,
  ManifestObject,
  ManifestRelationship,
  UpdateRelationshipInput,
} from "@/entities/manifests/types.ts"
import { apiErrorMessage, theirChanges } from "@/shared/lib/draft.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { ConflictNotice, type ConflictField } from "@/shared/ui/conflict-notice.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Label, Select } from "@/shared/ui/fields.tsx"

import {
  EMPTY_RELATIONSHIP,
  newRelationship,
  relationshipFields,
  relationshipPatch,
  type RelationshipField,
} from "./meaning-fields.ts"

type Payload = CreateRelationshipInput | UpdateRelationshipInput

const describeEnds = (relationship: ManifestRelationship) =>
  `${relationship.from.schema}.${relationship.from.name} (${relationship.from.columns.join(", ")}) → ${relationship.to.schema}.${relationship.to.name} (${relationship.to.columns.join(", ")})`

/** Present columns, plus the chosen one when it has left the source so the choice stays visible. */
function ColumnOptions({ columns, chosen }: { columns: ManifestColumn[]; chosen: string }) {
  const removed = chosen && !columns.some((column) => column.present && column.name === chosen)
  return (
    <>
      <option value="">Choose a column</option>
      {removed && (
        <option value={chosen} disabled>
          {chosen} (removed from the source)
        </option>
      )}
      {columns
        .filter((column) => column.present)
        .map((column) => (
          <option key={column.id} value={column.name}>
            {column.name} ({column.dataType})
          </option>
        ))}
    </>
  )
}

/**
 * Adds a manual relationship from a column of `object` to a column of any
 * table or view in the same source, or edits one: a manual relationship can
 * move to other columns, a discovered foreign key only takes a remark.
 */
export function RelationshipForm({
  workspaceId,
  connectionId,
  object,
  relationship,
  onClose,
}: {
  workspaceId: string
  connectionId: string
  /** The object whose page this is; new relationships start from it. */
  object: ManifestObject
  /** The relationship to edit, or null to add one. */
  relationship: ManifestRelationship | null
  onClose: () => void
}) {
  const id = useId()
  const isKey = relationship?.origin === "foreign_key"
  const from = relationship?.from ?? { objectId: object.id, schema: object.schema, name: object.name }
  const create = useCreateRelationship(workspaceId, connectionId)
  const update = useUpdateRelationship(workspaceId, connectionId)

  const editor = useVersionedEditor<RelationshipField, ManifestRelationship, Payload | null>({
    initial: relationship ? relationshipFields(relationship) : EMPTY_RELATIONSHIP,
    version: relationship?.version ?? 1,
    fieldsOf: relationshipFields,
    toPatch: (state) =>
      relationship
        ? relationshipPatch(state, fromColumns, toColumns)
        : newRelationship(state.draft, fromColumns, toColumns),
    save: (payload) => {
      if (!payload) return Promise.reject(new Error("Choose both columns first."))
      return relationship
        ? update.mutateAsync({ relationshipId: relationship.id, patch: payload as UpdateRelationshipInput })
        : create.mutateAsync(payload as CreateRelationshipInput)
    },
    onSaved: onClose,
  })
  const { draft } = editor.state

  const manifest = useManifest(workspaceId, connectionId, "")
  const fromDetail = useManifestObject(workspaceId, connectionId, isKey ? null : from.objectId)
  const toDetail = useManifestObject(
    workspaceId,
    connectionId,
    isKey || !draft.toObjectId ? null : draft.toObjectId,
  )
  const fromColumns = fromDetail.data?.columns ?? []
  const toColumns = toDetail.data?.columns ?? []
  const loadError = manifest.error ?? fromDetail.error ?? toDetail.error

  const ready =
    (relationship
      ? relationshipPatch(editor.state, fromColumns, toColumns)
      : newRelationship(draft, fromColumns, toColumns)) !== null

  // What changed since this form opened, described for the conflict notice.
  const theirs = theirChanges(editor.state)
  const conflict: ConflictField[] = []
  if (editor.newer && theirs.some((key) => key !== "remark")) {
    conflict.push({ label: "Columns", value: describeEnds(editor.newer) })
  }
  if (editor.newer && theirs.includes("remark")) {
    conflict.push({ label: "Remark", value: editor.newer.remark ?? "" })
  }

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-lg border border-(--border) bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void (editor.state.conflict ? editor.keepMine() : editor.save())
      }}
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {relationship ? (isKey ? "Foreign key remark" : "Edit relationship") : "Add a relationship"}
      </h3>
      {isKey && relationship ? (
        <p className="text-sm">
          <code className="break-all">{describeEnds(relationship)}</code>
          <span className="mt-1 block text-(--muted)">
            Foreign keys come from the source; you can add a remark about how they are used.
          </span>
        </p>
      ) : (
        <>
          <p className="text-sm text-(--muted)">
            Record a link the database does not declare. Both columns need comparable types, such as
            numbers with numbers or text with text.
          </p>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`}>
                Column in {from.schema}.{from.name}
              </Label>
              <Select
                id={`${id}-from`}
                value={draft.fromColumn}
                disabled={!fromDetail.data}
                autoFocus
                onChange={(event) => editor.setField("fromColumn", event.target.value)}
              >
                <ColumnOptions columns={fromColumns} chosen={draft.fromColumn} />
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to-object`}>Refers to table or view</Label>
              <Select
                id={`${id}-to-object`}
                value={draft.toObjectId}
                disabled={!manifest.data}
                onChange={(event) => {
                  editor.setField("toObjectId", event.target.value)
                  editor.setField("toColumn", "")
                }}
              >
                <option value="">Choose a table or view</option>
                {manifest.data?.schemas.map((schema) => (
                  <optgroup key={schema.name} label={schema.name}>
                    {schema.objects
                      .filter((candidate) => candidate.present || candidate.id === draft.toObjectId)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id} disabled={!candidate.present}>
                          {candidate.schema}.{candidate.name}
                          {!candidate.present && " (removed)"}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to-column`}>Refers to column</Label>
              <Select
                id={`${id}-to-column`}
                value={draft.toColumn}
                disabled={!toDetail.data}
                onChange={(event) => editor.setField("toColumn", event.target.value)}
              >
                <ColumnOptions columns={toColumns} chosen={draft.toColumn} />
              </Select>
              {draft.toObjectId && toDetail.isPending && (
                <p role="status" className="text-xs text-(--muted)">
                  Loading columns…
                </p>
              )}
            </div>
          </div>
        </>
      )}
      <div className="space-y-1">
        <Label htmlFor={`${id}-remark`}>Remark (optional)</Label>
        <Input
          id={`${id}-remark`}
          value={draft.remark}
          maxLength={1000}
          autoFocus={isKey}
          placeholder="e.g. Only set for orders placed through the marketplace"
          onChange={(event) => editor.setField("remark", event.target.value)}
        />
      </div>

      {loadError && (
        <FailureNotice title="Columns unavailable" message={apiErrorMessage(loadError)} />
      )}
      {editor.error !== null && (
        <FailureNotice title="Not saved" message={apiErrorMessage(editor.error)} />
      )}
      {editor.state.conflict && (
        <ConflictNotice
          by={null}
          at={null}
          fields={conflict}
          saving={editor.saving}
          onKeepMine={() => void editor.keepMine()}
          onTakeTheirs={editor.takeTheirs}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {!editor.state.conflict && (
          <Button type="submit" disabled={editor.saving || !ready}>
            {editor.saving ? "Saving…" : relationship ? "Save" : "Add relationship"}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose} disabled={editor.saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
