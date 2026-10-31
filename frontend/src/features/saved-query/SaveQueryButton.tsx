import { Save } from "lucide-react"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

import type { ConnectionEngine } from "@/entities/connections/types.ts"
import { Button } from "@/shared/ui/button.tsx"

import { SavedQueryEditor } from "./SavedQueryEditor.tsx"
import type { SavePrefill } from "./saved-query-form.ts"

/**
 * "Save as query": opens the editor in place, prefilled, and opens the saved
 * query once it is saved. `prefill` is read when the editor opens.
 */
export function SaveQueryButton({
  workspaceId,
  engine,
  sourceName,
  prefill,
}: {
  workspaceId: string
  engine: ConnectionEngine
  sourceName: string
  prefill: () => SavePrefill
}) {
  const navigate = useNavigate()
  const [opened, setOpened] = useState<SavePrefill | null>(null)

  if (!opened) {
    return (
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOpened(prefill())}>
        <Save aria-hidden className="size-3.5" />
        Save as query
      </Button>
    )
  }
  return (
    <div className="w-full rounded-md border border-(--border) bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">Save as query</h3>
      <SavedQueryEditor
        workspaceId={workspaceId}
        engine={engine}
        sourceName={sourceName}
        target={{ kind: "create", prefill: opened }}
        onSaved={(saved) =>
          navigate(`/saved/${encodeURIComponent(saved.id)}`, {
            state: { notice: `Saved “${saved.name}”.` },
          })
        }
        onCancel={() => setOpened(null)}
      />
    </div>
  )
}
