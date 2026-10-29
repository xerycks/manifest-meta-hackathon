import { useHealth } from "@/shared/api/health.ts"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { ErrorState, LoadingState } from "@/shared/ui/states.tsx"

export function HomePage() {
  const health = useHealth()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome to Manifest</h1>
        <p className="mt-1 max-w-2xl leading-7 text-(--muted)">
          Connect a database, document what its tables and columns mean, then ask questions and
          keep the queries and rows behind every answer.
        </p>
      </div>

      <Card>
        <CardTitle>API status</CardTitle>
        {health.isPending && <LoadingState label="Checking the API…" />}
        {health.isError && (
          <div className="mt-3">
            <ErrorState
              title="API unreachable"
              message={
                health.error instanceof Error
                  ? health.error.message
                  : "The backend did not respond."
              }
              onRetry={() => void health.refetch()}
            />
          </div>
        )}
        {health.isSuccess && (
          <CardDescription>
            Connected to {health.data.service} (up for {health.data.uptimeSeconds}s). Connect a
            source when you are ready to build your first manifest.
          </CardDescription>
        )}
      </Card>
    </div>
  )
}
