import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { useWorkspaces, type Workspace } from "@/shared/api/workspaces.ts"

const STORAGE_KEY = "manifest.workspaceId"

interface WorkspaceSessionValue {
  workspaces: Workspace[]
  isLoading: boolean
  error: Error | null
  workspace: Workspace | null
  workspaceId: string | null
  selectWorkspace: (id: string) => void
}

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(null)

export function WorkspaceSessionProvider({ children }: { children: ReactNode }) {
  const query = useWorkspaces()
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  const workspaces = useMemo(() => query.data ?? [], [query.data])

  useEffect(() => {
    if (workspaces.length === 0) return
    if (!selectedId || !workspaces.some((workspace) => workspace.id === selectedId)) {
      const first = workspaces[0]
      if (first) setSelectedId(first.id)
    }
  }, [workspaces, selectedId])

  const selectWorkspace = useCallback((id: string) => {
    setSelectedId(id)
    try {
      window.localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // Selection still works for this session without persistence.
    }
  }, [])

  const value = useMemo<WorkspaceSessionValue>(
    () => ({
      workspaces,
      isLoading: query.isPending,
      error: query.error instanceof Error ? query.error : null,
      workspace: workspaces.find((item) => item.id === selectedId) ?? null,
      workspaceId: selectedId,
      selectWorkspace,
    }),
    [workspaces, query.isPending, query.error, selectedId, selectWorkspace],
  )

  return (
    <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>
  )
}

export function useWorkspaceSession(): WorkspaceSessionValue {
  const value = useContext(WorkspaceSessionContext)
  if (!value) throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider")
  return value
}
