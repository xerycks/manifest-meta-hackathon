import { Component, lazy, Suspense, type ReactNode } from "react"
import { Navigate, Outlet, createBrowserRouter } from "react-router-dom"

import { HomePage } from "@/pages/home/HomePage.tsx"
import { KnowledgeEntryPage } from "@/pages/knowledge/KnowledgeEntryPage.tsx"
import { KnowledgePage } from "@/pages/knowledge/KnowledgePage.tsx"
import { NewKnowledgeEntryPage } from "@/pages/knowledge/NewKnowledgeEntryPage.tsx"
import { ManifestBrowserPage } from "@/pages/manifests/ManifestBrowserPage.tsx"
import { ManifestsPage } from "@/pages/manifests/ManifestsPage.tsx"
import { NotFoundPage } from "@/pages/not-found/NotFoundPage.tsx"
import { SettingsPage } from "@/pages/settings/SettingsPage.tsx"
import { SourcesPage } from "@/pages/sources/SourcesPage.tsx"
import { ErrorState, LoadingState } from "@/shared/ui/states.tsx"

import { AppLayout } from "./layouts/AppLayout.tsx"

// The connection form only loads when a source is added or edited.
const NewSourcePage = lazy(() =>
  import("@/pages/sources/NewSourcePage.tsx").then((module) => ({ default: module.NewSourcePage })),
)
const EditSourcePage = lazy(() =>
  import("@/pages/sources/EditSourcePage.tsx").then((module) => ({ default: module.EditSourcePage })),
)
// The ask screen, query runs, saved queries, dashboards, and routines load when first opened.
const AskPage = lazy(() => import("@/pages/ask/AskPage.tsx").then((module) => ({ default: module.AskPage })))
const ExecutionPage = lazy(() =>
  import("@/pages/sources/ExecutionPage.tsx").then((module) => ({ default: module.ExecutionPage })),
)
const SavedQueriesPage = lazy(() =>
  import("@/pages/saved/SavedQueriesPage.tsx").then((module) => ({ default: module.SavedQueriesPage })),
)
const SavedQueryPage = lazy(() =>
  import("@/pages/saved/SavedQueryPage.tsx").then((module) => ({ default: module.SavedQueryPage })),
)
const DashboardsPage = lazy(() =>
  import("@/pages/dashboards/DashboardsPage.tsx").then((module) => ({ default: module.DashboardsPage })),
)
const DashboardPage = lazy(() =>
  import("@/pages/dashboards/DashboardPage.tsx").then((module) => ({ default: module.DashboardPage })),
)
const RoutinesPage = lazy(() =>
  import("@/pages/routines/RoutinesPage.tsx").then((module) => ({ default: module.RoutinesPage })),
)
const NewRoutinePage = lazy(() =>
  import("@/pages/routines/NewRoutinePage.tsx").then((module) => ({ default: module.NewRoutinePage })),
)
const RoutinePage = lazy(() =>
  import("@/pages/routines/RoutinePage.tsx").then((module) => ({ default: module.RoutinePage })),
)

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<LoadingState label="Loading…" />}>{children}</Suspense>
}

class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorState
          title="This page hit an error"
          message="Reload the page to try again. If it keeps failing, note what you were doing and report it."
          onRetry={() => window.location.reload()}
        />
      )
    }
    return this.props.children
  }
}

function GuardedOutlet() {
  return (
    <RouteErrorBoundary>
      <Outlet />
    </RouteErrorBoundary>
  )
}

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      {
        element: <GuardedOutlet />,
        children: [
          { index: true, element: <HomePage /> },
          { path: "ask", element: <Lazy><AskPage /></Lazy> },
          { path: "ask/:conversationId", element: <Lazy><AskPage /></Lazy> },
          { path: "sources", element: <SourcesPage /> },
          { path: "sources/new", element: <Lazy><NewSourcePage /></Lazy> },
          { path: "sources/:connectionId", element: <Lazy><EditSourcePage /></Lazy> },
          { path: "sources/:connectionId/queries/:executionId", element: <Lazy><ExecutionPage /></Lazy> },
          { path: "manifests", element: <ManifestsPage /> },
          { path: "manifests/knowledge", element: <KnowledgePage /> },
          { path: "manifests/knowledge/new", element: <NewKnowledgeEntryPage /> },
          { path: "manifests/knowledge/:entryId", element: <KnowledgeEntryPage /> },
          { path: "manifests/:connectionId", element: <ManifestBrowserPage /> },
          { path: "manifests/:connectionId/objects/:objectId", element: <ManifestBrowserPage /> },
          { path: "saved", element: <Lazy><SavedQueriesPage /></Lazy> },
          { path: "saved/:savedQueryId", element: <Lazy><SavedQueryPage /></Lazy> },
          { path: "dashboards", element: <Lazy><DashboardsPage /></Lazy> },
          { path: "dashboards/:dashboardId", element: <Lazy><DashboardPage /></Lazy> },
          { path: "routines", element: <Lazy><RoutinesPage /></Lazy> },
          { path: "routines/new", element: <Lazy><NewRoutinePage /></Lazy> },
          { path: "routines/:routineId", element: <Lazy><RoutinePage /></Lazy> },
          { path: "settings", element: <SettingsPage /> },
          { path: "home", element: <Navigate to="/" replace /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
