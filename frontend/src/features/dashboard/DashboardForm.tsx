import { useId, useRef, useState } from "react"

import { useCreateDashboard, useUpdateDashboard } from "@/entities/dashboards/api.ts"
import {
  DASHBOARD_LIMITS,
  type CreateDashboardInput,
  type DashboardDetail,
  type UpdateDashboardInput,
} from "@/entities/dashboards/types.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage, theirChanges } from "@/shared/lib/draft.ts"
import { useVersionedEditor } from "@/shared/lib/use-versioned-editor.ts"
import { Button } from "@/shared/ui/button.tsx"
import { ConflictNotice, type ConflictField } from "@/shared/ui/conflict-notice.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"

import {
  dashboardFields,
  dashboardPatch,
  EMPTY_DASHBOARD,
  nameProblem,
  newDashboard,
  type DashboardField,
} from "./dashboard-form.ts"

const CONFLICT_LABELS: Record<DashboardField, string> = {
  name: "Name",
  description: "Description",
  visibility: "Visibility",
}

/**
 * Creates a dashboard or edits its name, description, and visibility. A
 * failed save keeps everything typed; a save rejected as stale shows the
 * newer version next to the draft.
 */
export function DashboardForm({
  workspaceId,
  dashboard,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  /** The dashboard to edit, or null to create one. */
  dashboard: DashboardDetail | null
  onSaved: (dashboard: DashboardDetail) => void
  onCancel: () => void
}) {
  const id = useId()
  const context = useSessionContext()
  const nameInput = useRef<HTMLInputElement>(null)
  const saved = useRef<DashboardDetail | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const create = useCreateDashboard(workspaceId)
  const update = useUpdateDashboard(workspaceId, dashboard?.id ?? "")

  const editor = useVersionedEditor<
    DashboardField,
    DashboardDetail,
    CreateDashboardInput | UpdateDashboardInput
  >({
    initial: dashboard ? dashboardFields(dashboard) : EMPTY_DASHBOARD,
    version: dashboard?.version ?? 1,
    fieldsOf: dashboardFields,
    toPatch: (state) => (dashboard ? dashboardPatch(state) : newDashboard(state.draft)),
    save: async (payload) => {
      saved.current = dashboard
        ? await update.mutateAsync(payload as UpdateDashboardInput)
        : await create.mutateAsync(payload as CreateDashboardInput)
    },
    // Nothing changed: closing the editor is the whole save.
    onSaved: () => (saved.current ? onSaved(saved.current) : onCancel()),
  })
  const { draft } = editor.state

  function submit() {
    const problem = nameProblem(draft.name)
    setNameError(problem)
    if (problem) {
      nameInput.current?.focus()
      return
    }
    void (editor.state.conflict ? editor.keepMine() : editor.save())
  }

  const newer = editor.newer
  const conflict: ConflictField[] = newer
    ? theirChanges(editor.state).map((key) => {
        if (key === "description")
          return { label: CONFLICT_LABELS[key], value: newer.description, markdown: true }
        if (key === "visibility") {
          return {
            label: CONFLICT_LABELS[key],
            value: newer.visibility === "private" ? "Only its creator" : "Everyone",
          }
        }
        return { label: CONFLICT_LABELS[key], value: newer.name }
      })
    : []
  // An owner or admin editing someone else's dashboard makes it private to its creator.
  const creator = dashboard?.createdBy
  const mine = !dashboard || (creator !== null && creator?.id === context.data?.user.id)

  return (
    <form
      aria-label={dashboard ? `Edit ${dashboard.name}` : "New dashboard"}
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <Field id={`${id}-name`} label="Name" error={nameError ?? undefined}>
        <Input
          ref={nameInput}
          {...described(`${id}-name`, nameError ?? undefined)}
          value={draft.name}
          maxLength={DASHBOARD_LIMITS.nameChars}
          placeholder="e.g. Weekly store overview"
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
          maxLength={DASHBOARD_LIMITS.descriptionChars}
          rows={3}
          placeholder="Who it is for and how to read it…"
        />
      </div>
      <Choice
        label="Who can see it"
        value={draft.visibility}
        options={[
          { value: "workspace", label: "Everyone in the workspace" },
          {
            value: "private",
            label: mine ? "Only me" : `Only its creator${creator ? ` (${creator.name})` : ""}`,
          },
        ]}
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
            {editor.saving ? "Saving…" : dashboard ? "Save changes" : "Create dashboard"}
          </Button>
        )}
        <Button variant="secondary" onClick={onCancel} disabled={editor.saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
