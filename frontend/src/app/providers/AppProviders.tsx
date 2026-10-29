import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState, type ReactNode } from "react"

import { WorkspaceSessionProvider } from "../workspace-session/WorkspaceSession.tsx"

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      <WorkspaceSessionProvider>{children}</WorkspaceSessionProvider>
    </QueryClientProvider>
  )
}
