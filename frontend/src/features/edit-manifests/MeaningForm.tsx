import { useId, type ReactNode } from "react"

import { apiErrorMessage } from "@/shared/lib/draft.ts"
import type { VersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { ConflictNotice } from "@/shared/ui/conflict-notice.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Label, Textarea } from "@/shared/ui/fields.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"

import { conflictFields, type FieldDef } from "./meaning-fields.ts"

/**
 * The inline editor for authored text fields. A failed save keeps it open
 * with the draft and the error; a stale save shows the newer version and
 * keeps the draft until the user decides.
 */
export function MeaningForm<K extends string>({
  title,
  fields,
  editor,
  newerBy,
  newerAt,
  onCancel,
}: {
  title: ReactNode
  fields: readonly FieldDef<K>[]
  editor: VersionedEditor<K, unknown>
  /** Who saved the newer version, and when, while a conflict is shown. */
  newerBy: string | null
  newerAt: string | null
  onCancel: () => void
}) {
  const id = useId()
  const { state } = editor

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="space-y-4 rounded-lg border border-(--border) bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault()
        void (state.conflict ? editor.keepMine() : editor.save())
      }}
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {title}
      </h3>
      {fields.map((field, index) => {
        const fieldId = `${id}-${field.key}`
        const value = state.draft[field.key]
        const onChange = (next: string) => editor.setField(field.key, next)
        return (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={fieldId}>{field.label}</Label>
            {field.kind === "markdown" ? (
              <MarkdownEditor
                id={fieldId}
                value={value}
                onChange={onChange}
                maxLength={field.max}
                placeholder={field.placeholder}
              />
            ) : field.kind === "text" ? (
              <Textarea
                id={fieldId}
                value={value}
                rows={3}
                maxLength={field.max}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value)}
              />
            ) : (
              <Input
                id={fieldId}
                value={value}
                maxLength={field.max}
                placeholder={field.placeholder}
                autoFocus={index === 0}
                onChange={(event) => onChange(event.target.value)}
              />
            )}
          </div>
        )
      })}

      {editor.error !== null && (
        <FailureNotice title="Not saved" message={apiErrorMessage(editor.error)} />
      )}
      {state.conflict && (
        <ConflictNotice
          by={newerBy}
          at={newerAt}
          fields={conflictFields(state, fields)}
          saving={editor.saving}
          onKeepMine={() => void editor.keepMine()}
          onTakeTheirs={editor.takeTheirs}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {!state.conflict && (
          <Button type="submit" disabled={editor.saving}>
            {editor.saving ? "Saving…" : "Save"}
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={editor.saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
