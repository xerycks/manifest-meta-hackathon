import {
  BookOpenText,
  ChartColumn,
  Database,
  House,
  LogOut,
  MessageCircleQuestion,
  Save,
  Settings,
  Timer,
} from "lucide-react"
import { NavLink, Outlet } from "react-router-dom"

import { roleLabels } from "@/app/organization-role.ts"
import { useWorkspaceSession } from "@/app/workspace-session/WorkspaceSession.tsx"
import { useSessionContext, useSignOut } from "@/shared/api/auth.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Select } from "@/shared/ui/fields.tsx"

const NAV_ITEMS = [
  { to: "/", label: "Home", icon: House, end: true },
  { to: "/ask", label: "Ask", icon: MessageCircleQuestion },
  { to: "/sources", label: "Sources", icon: Database },
  { to: "/manifests", label: "Manifests", icon: BookOpenText },
  { to: "/saved", label: "Saved queries", icon: Save },
  { to: "/dashboards", label: "Dashboards", icon: ChartColumn },
  { to: "/routines", label: "Routines", icon: Timer },
  { to: "/settings", label: "Settings", icon: Settings },
] as const

function navLinkClass({ isActive }: { isActive: boolean }): string {
  return cn(
    "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)",
    isActive
      ? "bg-(--surface) text-(--foreground)"
      : "text-(--muted) hover:bg-(--surface) hover:text-(--foreground)",
  )
}

export function AppLayout() {
  const session = useWorkspaceSession()
  const context = useSessionContext()
  const signOut = useSignOut()
  const user = context.data?.user

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>
      <header className="border-b border-(--border) md:min-h-dvh md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="px-4 pt-4 md:px-5 md:pt-5">
          <NavLink to="/" className="text-base font-semibold tracking-tight">
            Manifest
          </NavLink>
          <p className="mt-0.5 hidden text-xs text-(--muted) md:block">
            Ask your data, with evidence.
          </p>
          {session.workspaces.length > 0 && (
            <div className="mt-3 hidden md:block">
              <label htmlFor="layout-workspace-picker" className="text-xs font-medium text-(--muted)">
                Workspace
              </label>
              <Select
                id="layout-workspace-picker"
                className="mt-1"
                value={session.workspaceId ?? ""}
                onChange={(event) => session.selectWorkspace(event.target.value)}
              >
                {session.workspaces.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <nav aria-label="Primary" className="flex gap-1 overflow-x-auto p-3 md:flex-col md:p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item}
              className={navLinkClass}
            >
              <item.icon aria-hidden className="size-4 shrink-0" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        {user && (
          <div className="border-t border-(--border) p-4">
            <p className="truncate text-sm font-medium">{user.name || user.email}</p>
            <p className="truncate text-xs text-(--muted)">
              {user.email}
              {session.workspaceRole ? ` · ${roleLabels[session.workspaceRole]}` : ""}
            </p>
            <Button
              variant="ghost"
              className="mt-2 px-2"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              <LogOut aria-hidden className="size-4" />
              Sign out
            </Button>
          </div>
        )}
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8 md:py-8">
        <Outlet />
      </main>
    </div>
  )
}
