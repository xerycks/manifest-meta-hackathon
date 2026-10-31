import { useState, type FormEvent } from "react"

import { useAddPanel, useUpdatePanel } from "@/entities/dashboards/api.ts"
import type { DashboardDetail, DashboardPanel } from "@/entities/dashboards/types.ts"
import { useSavedQuery } from "@/entities/saved-queries/api.ts"
import { apiErrorMessage, staleRecord } from "@/shared/lib/draft.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Dialog } from "@/shared/ui/dialog.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { PanelEditor } from "./PanelEditor.tsx"
import {
  draftFromPanel,
  newPanelDraft,
  panelInput,
  panelPatch,
  privateQueryProblem,
  type PanelErrors,
} from "./panel-form.ts"

/**
 * Adds a panel to a dashboard or edits one. A failed save keeps every
 * setting; an edit someone else saved first says so, and saving again
 * replaces their version.
 */
export function PanelDialog({
  workspaceId,
  dashboard,
  panel,
  onSaved,
  onClose,
}: {
  workspaceId: string
  dashboard: DashboardDetail
  /** The panel to edit, or null to add one. */
  panel: DashboardPanel | null
  onSaved: (message: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(() => (panel ? draftFromPanel(panel) : newPanelDraft()))
  const [errors, setErrors] = useState<PanelErrors>({})
  const [version, setVersion] = useState(panel?.version ?? 1)
  const [conflict, setConflict] = useState(false)
  const selected = useSavedQuery(workspaceId, draft.kind === "markdown" ? "" : draft.savedQueryId)
  const add = useAddPanel(workspaceId)
  const update = useUpdatePanel(workspaceId, dashboard.id)
  const saving = add.isPending || update.isPending
  const error = panel ? update.error : add.error

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const columns = selected.data?.latestRun?.result?.columns ?? null
    const built = panelInput(draft, draft.kind === "markdown" ? null : columns)
    const problems = "errors" in built ? built.errors : {}
    const shared = privateQueryProblem(draft, selected.data, dashboard)
    if (shared) problems.savedQueryId ??= shared
    setErrors(problems)
    if ("errors" in built || shared) return
    setConflict(false)
    if (!panel) {
      add.mutate(
        { dashboardId: dashboard.id, input: built.input },
        { onSuccess: () => onSaved("Added a panel.") },
      )
      return
    }
    update.mutate(
      { panelId: panel.id, patch: panelPatch({ version }, built.input) },
      {
        onSuccess: () => onSaved("Saved the panel."),
        onError: (caught) => {
          const current = staleRecord<DashboardPanel>(caught)
          if (!current) return
          setVersion(current.version)
          setConflict(true)
        },
      },
    )
  }

  return (
    <Dialog
      title={panel ? "Edit panel" : "Add a panel"}
      description={`On “${dashboard.name}”`}
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        <PanelEditor
          workspaceId={workspaceId}
          draft={draft}
          errors={errors}
          selected={selected}
          disabled={saving}
          onChange={setDraft}
        />
        {conflict ? (
          <p
            role="alert"
            className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm leading-6 text-(--warning)"
          >
            Someone changed this panel after you opened it. Your settings are still here: save again to
            replace their version, or cancel to keep it.
          </p>
        ) : (
          error && <FailureNotice title="Not saved" message={apiErrorMessage(error)} />
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : panel ? "Save panel" : "Add panel"}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
