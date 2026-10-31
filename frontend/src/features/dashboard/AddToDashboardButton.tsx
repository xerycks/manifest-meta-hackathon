import { LayoutDashboard } from "lucide-react"
import { useId, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useAddPanel, useCreateDashboard, useDashboards } from "@/entities/dashboards/api.ts"
import { canEditDashboard } from "@/entities/dashboards/panel-config.ts"
import { DASHBOARD_LIMITS, type DashboardDetail } from "@/entities/dashboards/types.ts"
import { useSavedQuery } from "@/entities/saved-queries/api.ts"
import type { SavedQueryDetail } from "@/entities/saved-queries/types.ts"
import { useSessionContext } from "@/shared/api/auth.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Dialog } from "@/shared/ui/dialog.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Select } from "@/shared/ui/fields.tsx"
import { described, Field } from "@/shared/ui/form-field.tsx"

import { nameProblem } from "./dashboard-form.ts"
import { PanelEditor } from "./PanelEditor.tsx"
import { newPanelDraft, panelInput, privateQueryProblem, type PanelErrors } from "./panel-form.ts"

const NEW = "new"

function AddToDashboardDialog({
  workspaceId,
  savedQuery,
  onClose,
}: {
  workspaceId: string
  savedQuery: SavedQueryDetail
  onClose: () => void
}) {
  const id = useId()
  const navigate = useNavigate()
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const dashboards = useDashboards(workspaceId)
  const selected = useSavedQuery(workspaceId, savedQuery.id)
  const create = useCreateDashboard(workspaceId)
  const add = useAddPanel(workspaceId)
  // A dashboard made here is kept if adding the panel then fails, so trying again does not make another.
  const [created, setCreated] = useState<DashboardDetail | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [name, setName] = useState(savedQuery.name.slice(0, DASHBOARD_LIMITS.nameChars))
  const [draft, setDraft] = useState(() => newPanelDraft(savedQuery.id))
  const [errors, setErrors] = useState<PanelErrors & { dashboard?: string }>({})
  const [failure, setFailure] = useState<unknown>(null)
  const [saving, setSaving] = useState(false)

  const listed = (dashboards.data?.dashboards ?? []).filter((item) =>
    canEditDashboard(item, context.data?.user.id, session.workspaceRole),
  )
  const editable =
    created && !listed.some((item) => item.id === created.id)
      ? [{ ...created, excerpt: "", panelCount: 0 }, ...listed]
      : listed
  const target = choice ?? (dashboards.isPending ? "" : (editable[0]?.id ?? NEW))
  const chosen = editable.find((item) => item.id === target)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const built = panelInput(draft, selected.data?.latestRun?.result?.columns ?? null)
    const problems: PanelErrors & { dashboard?: string } = "errors" in built ? { ...built.errors } : {}
    if (!target) problems.dashboard = "Choose a dashboard."
    else if (target === NEW) problems.dashboard = nameProblem(name) ?? undefined
    const shared = privateQueryProblem(draft, savedQuery, chosen)
    if (shared) problems.savedQueryId = shared
    setErrors(problems)
    if ("errors" in built || Object.values(problems).some(Boolean)) return

    setSaving(true)
    setFailure(null)
    try {
      let dashboard = chosen ?? null
      if (target === NEW) {
        // A private saved query can only go on a private dashboard.
        const visibility = savedQuery.visibility === "private" ? "private" : "workspace"
        const made = await create.mutateAsync({ name: name.trim(), description: "", visibility })
        setCreated(made)
        setChoice(made.id)
        dashboard = { ...made, excerpt: "", panelCount: 0 }
      }
      if (!dashboard) return
      await add.mutateAsync({ dashboardId: dashboard.id, input: built.input })
      navigate(`/dashboards/${encodeURIComponent(dashboard.id)}`, {
        state: { notice: `Added “${savedQuery.name}” to “${dashboard.name}”.` },
      })
    } catch (caught) {
      setFailure(caught)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title="Add to dashboard" description={`Show “${savedQuery.name}” as a panel.`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
        <Field
          id={`${id}-dashboard`}
          label="Dashboard"
          error={target === NEW ? undefined : errors.dashboard}
          hint={
            dashboards.isError
              ? `Dashboards could not be loaded. ${apiErrorMessage(dashboards.error)}`
              : undefined
          }
        >
          <Select
            {...described(`${id}-dashboard`, target === NEW ? undefined : errors.dashboard)}
            data-autofocus
            value={target}
            disabled={saving || dashboards.isPending}
            onChange={(event) => setChoice(event.target.value)}
          >
            {dashboards.isPending && <option value="">Loading dashboards…</option>}
            {editable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.visibility === "private" ? " · only you" : ""}
              </option>
            ))}
            <option value={NEW}>New dashboard…</option>
          </Select>
        </Field>
        {target === NEW && (
          <Field id={`${id}-name`} label="New dashboard name" error={errors.dashboard}>
            <Input
              {...described(`${id}-name`, errors.dashboard)}
              value={name}
              maxLength={DASHBOARD_LIMITS.nameChars}
              disabled={saving}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        <PanelEditor
          workspaceId={workspaceId}
          draft={draft}
          errors={errors}
          selected={selected}
          fixedSavedQuery
          disabled={saving}
          onChange={setDraft}
        />
        {failure !== null && <FailureNotice title="Not added" message={apiErrorMessage(failure)} />}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? "Adding…" : "Add panel"}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** "Add to dashboard" on a saved query: choose or name a dashboard and set up the panel. */
export function AddToDashboardButton({
  workspaceId,
  savedQuery,
}: {
  workspaceId: string
  savedQuery: SavedQueryDetail
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <LayoutDashboard aria-hidden className="size-4" />
        Add to dashboard
      </Button>
      {open && (
        <AddToDashboardDialog
          workspaceId={workspaceId}
          savedQuery={savedQuery}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
