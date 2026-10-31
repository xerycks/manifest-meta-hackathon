import { ArrowLeft } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { RoutineForm } from "@/features/manage-routines/RoutineForm.tsx"
import { useWorkspaceSetting } from "@/shared/api/workspaces.ts"
import { Card } from "@/shared/ui/card.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

const DEFAULT_TIME_ZONE = "UTC"

/** A new routine, starting from a saved query when its page sent one, in the workspace time zone. */
export function NewRoutinePage() {
  const session = useWorkspaceSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const savedQueryId = params.get("savedQueryId") ?? undefined
  const setting = useWorkspaceSetting(session.workspaceId, "timezone")
  // Until an owner or admin sets one (the setting is missing), the workspace is on UTC.
  const settled = setting.isSuccess || setting.isError
  const timeZone =
    setting.isSuccess && typeof setting.data.value === "string" ? setting.data.value : DEFAULT_TIME_ZONE

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/routines"
          className="inline-flex items-center gap-1.5 rounded-md text-sm text-(--muted) hover:text-(--foreground) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          <ArrowLeft aria-hidden className="size-4" />
          Routines
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New routine</h1>
        <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
          It runs as you, with what you can open. Anyone in the workspace can see it and how its runs went; the
          answers to a question stay in your own conversation.
        </p>
      </div>
      {!session.workspaceId || !settled ? (
        <LoadingState label="Loading…" />
      ) : (
        <Card>
          <RoutineForm
            workspaceId={session.workspaceId}
            routine={null}
            initial={{ ...(savedQueryId ? { savedQueryId } : {}), timeZone }}
            onSaved={(created) =>
              navigate(`/routines/${encodeURIComponent(created.id)}`, {
                state: { notice: `Created “${created.name}”.` },
              })
            }
            onCancel={() => navigate(savedQueryId ? `/saved/${encodeURIComponent(savedQueryId)}` : "/routines")}
          />
        </Card>
      )}
    </div>
  )
}
