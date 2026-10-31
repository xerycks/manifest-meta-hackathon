import { Component, lazy, Suspense, type ReactNode } from "react"
import { Navigate, Outlet, createBrowserRouter } from "react-router-dom"

import { HomePage } from "@/pages/home/HomePage.tsx"
import { KnowledgeEntryPage } from "@/pages/knowledge/KnowledgeEntryPage.tsx"
import { KnowledgePage } from "@/pages/knowledge/KnowledgePage.tsx"
import { NewKnowledgeEntryPage } from "@/pages/knowledge/NewKnowledgeEntryPage.tsx"
import { ManifestBrowserPage } from "@/pages/manifests/ManifestBrowserPage.tsx"
import { ManifestsPage } from "@/pages/manifests/ManifestsPage.tsx"
import { NotFoundPage } from "@/pages/not-found/NotFoundPage.tsx"
import { PlaceholderPage } from "@/pages/placeholder/PlaceholderPage.tsx"
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
          {
            path: "ask",
            element: (
              <PlaceholderPage
                title="Ask"
                emptyTitle="No conversations yet"
                description="Once a source is connected and documented, you can ask questions here and inspect the evidence behind each answer."
              />
            ),
          },
          { path: "sources", element: <SourcesPage /> },
          { path: "sources/new", element: <Lazy><NewSourcePage /></Lazy> },
          { path: "sources/:connectionId", element: <Lazy><EditSourcePage /></Lazy> },
          { path: "manifests", element: <ManifestsPage /> },
          { path: "manifests/knowledge", element: <KnowledgePage /> },
          { path: "manifests/knowledge/new", element: <NewKnowledgeEntryPage /> },
          { path: "manifests/knowledge/:entryId", element: <KnowledgeEntryPage /> },
          { path: "manifests/:connectionId", element: <ManifestBrowserPage /> },
          { path: "manifests/:connectionId/objects/:objectId", element: <ManifestBrowserPage /> },
          {
            path: "saved",
            element: (
              <PlaceholderPage
                title="Saved queries"
                emptyTitle="No saved queries"
                description="Turn a useful answer into a saved query you can reopen, rerun, and export."
              />
            ),
          },
          {
            path: "dashboards",
            element: (
              <PlaceholderPage
                title="Dashboards"
                emptyTitle="No dashboards yet"
                description="Pin saved results as numbers, tables, and charts that refresh from the same checked queries."
              />
            ),
          },
          {
            path: "routines",
            element: (
              <PlaceholderPage
                title="Routines"
                emptyTitle="No routines scheduled"
                description="Run a saved analysis on a schedule and keep a visible history of every run."
              />
            ),
          },
          { path: "settings", element: <SettingsPage /> },
          { path: "home", element: <Navigate to="/" replace /> },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
])
