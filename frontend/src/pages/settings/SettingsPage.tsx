import { useEffect, useState, type FormEvent } from "react"

import { managesWorkspace, roleLabels } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { ApiError } from "@/shared/api/client.ts"
import {
  useCreateWorkspace,
  useSetWorkspaceSetting,
  useWorkspaceSetting,
} from "@/shared/api/workspaces.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { Input, Label, Select } from "@/shared/ui/fields.tsx"
import { ErrorState, LoadingState } from "@/shared/ui/states.tsx"

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return "Request failed."
}

const DEFAULT_TIME_ZONE = "UTC"
const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")]

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return true
  } catch {
    return false
  }
}

/** The IANA time zone relative dates resolve in (saved query parameters now, routines later). */
function TimeZoneCard({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const setting = useWorkspaceSetting(workspaceId, "timezone")
  const save = useSetWorkspaceSetting(workspaceId, "timezone")
  const stored = setting.isSuccess && typeof setting.data.value === "string" ? setting.data.value : null
  const [draft, setDraft] = useState("")
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (setting.isSuccess || setting.isError) setDraft(stored ?? DEFAULT_TIME_ZONE)
  }, [setting.isSuccess, setting.isError, stored])

  const onSave = (event: FormEvent) => {
    event.preventDefault()
    const zone = draft.trim()
    if (!isTimeZone(zone)) {
      setProblem("Choose a time zone from the list, such as Europe/Berlin or America/New_York.")
      return
    }
    setProblem(null)
    save.mutate(zone)
  }

  return (
    <Card>
      <CardTitle>Time zone</CardTitle>
      <CardDescription>
        Relative dates in saved query parameters, such as “start of this month”, resolve in this time
        zone when a query runs. {stored ? "" : "Until someone sets one, it is UTC."}
      </CardDescription>
      <form onSubmit={onSave} className="mt-4 space-y-3" noValidate>
        <div className="max-w-sm space-y-1.5">
          <Label htmlFor="workspace-time-zone">Time zone</Label>
          <Input
            id="workspace-time-zone"
            list="workspace-time-zones"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={setting.isPending || !canManage}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "workspace-time-zone-problem" : undefined}
          />
          <datalist id="workspace-time-zones">
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          {problem && (
            <p id="workspace-time-zone-problem" className="text-xs font-medium text-(--danger)">
              {problem}
            </p>
          )}
        </div>
        {save.isError && <ErrorState title="Could not save" message={errorMessage(save.error)} />}
        {save.isSuccess && (
          <p role="status" className="text-sm text-(--muted)">
            Saved. Saved queries resolve their dates in {save.data.value as string} from now on.
          </p>
        )}
        <Button type="submit" disabled={save.isPending || !canManage}>
          {save.isPending ? "Saving…" : "Save time zone"}
        </Button>
      </form>
    </Card>
  )
}

export function SettingsPage() {
  const session = useWorkspaceSession()
  const workspace = session.workspace
  const canManage = managesWorkspace(session.workspaceRole)

  const description = useWorkspaceSetting(session.workspaceId, "description")
  const saveDescription = useSetWorkspaceSetting(session.workspaceId, "description")
  const [descriptionDraft, setDescriptionDraft] = useState("")

  const createWorkspace = useCreateWorkspace()
  const [newName, setNewName] = useState("")

  useEffect(() => {
    if (description.isSuccess && typeof description.data.value === "string") {
      setDescriptionDraft(description.data.value)
    }
    if (description.isError) setDescriptionDraft("")
  }, [description.isSuccess, description.isError, description.data, session.workspaceId])

  const onSaveDescription = (event: FormEvent) => {
    event.preventDefault()
    saveDescription.mutate(descriptionDraft)
  }

  const onCreateWorkspace = (event: FormEvent) => {
    event.preventDefault()
    const slug = slugify(newName)
    if (!slug) return
    createWorkspace.mutate(
      { name: newName.trim(), slug },
      {
        onSuccess: (created) => {
          setNewName("")
          session.selectWorkspace(created.id)
        },
      },
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 leading-7 text-(--muted)">
          Workspaces keep sources, manifests, and settings separate. Everything you save here is
          scoped to the selected workspace.
        </p>
      </div>

      {session.isLoading && <LoadingState label="Loading workspaces…" />}
      {session.error && (
        <ErrorState title="Workspaces unavailable" message={errorMessage(session.error)} />
      )}

      {!session.isLoading && !session.error && (
        <>
          <Card>
            <CardTitle>Current workspace</CardTitle>
            {session.workspaces.length === 0 ? (
              <CardDescription>
                No workspaces yet. Create your first one below — or run the backend seed for a
                synthetic demo workspace.
              </CardDescription>
            ) : (
              <div className="mt-3 max-w-sm space-y-1.5">
                <Label htmlFor="workspace-picker">Workspace</Label>
                <Select
                  id="workspace-picker"
                  value={session.workspaceId ?? ""}
                  onChange={(event) => session.selectWorkspace(event.target.value)}
                >
                  {session.workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.slug})
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Card>

          {workspace && (
            <Card>
              <CardTitle>Workspace description</CardTitle>
              <CardDescription>
                Stored per workspace. Switch workspaces above and this text changes with it — one
                workspace never sees another's settings.
                {session.workspaceRole && (
                  <>
                    {" "}
                    Your role here is {roleLabels[session.workspaceRole]}
                    {canManage ? "." : " — only owners and admins can change this."}
                  </>
                )}
              </CardDescription>
              <form onSubmit={onSaveDescription} className="mt-4 space-y-3">
                <div className="max-w-lg space-y-1.5">
                  <Label htmlFor="workspace-description">Description</Label>
                  <Input
                    id="workspace-description"
                    value={descriptionDraft}
                    onChange={(event) => setDescriptionDraft(event.target.value)}
                    placeholder="What is this workspace for?"
                    disabled={description.isPending || !canManage}
                  />
                </div>
                {saveDescription.isError && (
                  <ErrorState
                    title="Could not save"
                    message={errorMessage(saveDescription.error)}
                  />
                )}
                {saveDescription.isSuccess && (
                  <p role="status" className="text-sm text-(--muted)">
                    Saved. It will still be here after a restart.
                  </p>
                )}
                <Button type="submit" disabled={saveDescription.isPending || !canManage}>
                  {saveDescription.isPending ? "Saving…" : "Save description"}
                </Button>
              </form>
            </Card>
          )}

          {workspace && <TimeZoneCard key={workspace.id} workspaceId={workspace.id} canManage={canManage} />}

          <Card>
            <CardTitle>Create a workspace</CardTitle>
            <CardDescription>
              The slug is derived from the name and must be unique.
            </CardDescription>
            <form onSubmit={onCreateWorkspace} className="mt-4 space-y-3">
              <div className="max-w-sm space-y-1.5">
                <Label htmlFor="workspace-name">Name</Label>
                <Input
                  id="workspace-name"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder="e.g. Sales analytics"
                  required
                />
              </div>
              {createWorkspace.isError && (
                <ErrorState
                  title="Could not create workspace"
                  message={errorMessage(createWorkspace.error)}
                />
              )}
              <Button type="submit" disabled={createWorkspace.isPending || !newName.trim()}>
                {createWorkspace.isPending ? "Creating…" : "Create workspace"}
              </Button>
            </form>
          </Card>
        </>
      )}
    </div>
  )
}
