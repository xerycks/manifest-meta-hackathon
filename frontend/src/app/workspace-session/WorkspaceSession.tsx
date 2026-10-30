import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import type { WorkspaceRole } from "@/app/organization-role.ts"
import { useSessionContext, type WorkspaceMembership } from "@/shared/api/auth.ts"

const STORAGE_KEY = "manifest.workspaceId"

interface WorkspaceSessionValue {
  workspaces: WorkspaceMembership[]
  isLoading: boolean
  error: Error | null
  workspace: WorkspaceMembership | null
  workspaceId: string | null
  workspaceRole: WorkspaceRole | null
  selectWorkspace: (id: string) => void
}

const WorkspaceSessionContext = createContext<WorkspaceSessionValue | null>(null)

export function WorkspaceSessionProvider({ children }: { children: ReactNode }) {
  const context = useSessionContext()
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  const workspaces = useMemo(
    () => context.data?.memberships ?? [],
    [context.data?.memberships],
  )

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

  const value = useMemo<WorkspaceSessionValue>(() => {
    const workspace = workspaces.find((item) => item.id === selectedId) ?? null
    return {
      workspaces,
      isLoading: context.isPending,
      error: context.error instanceof Error ? context.error : null,
      workspace,
      workspaceId: workspace?.id ?? null,
      workspaceRole: workspace?.role ?? null,
      selectWorkspace,
    }
  }, [workspaces, context.isPending, context.error, selectedId, selectWorkspace])

  return (
    <WorkspaceSessionContext.Provider value={value}>{children}</WorkspaceSessionContext.Provider>
  )
}

export function useWorkspaceSession(): WorkspaceSessionValue {
  const value = useContext(WorkspaceSessionContext)
  if (!value) throw new Error("useWorkspaceSession must be used inside WorkspaceSessionProvider")
  return value
}
