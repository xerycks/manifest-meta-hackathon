import { useEffect, useState } from "react"

type HealthState =
  | { kind: "loading" }
  | { kind: "ok"; uptimeSeconds: number }
  | { kind: "error" }

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" })

  useEffect(() => {
    let cancelled = false
    fetch("/api/health")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Health check failed (${response.status})`)
        const body = (await response.json()) as {
          success: boolean
          result?: { status: string; uptimeSeconds: number }
        }
        if (!body.success || body.result?.status !== "ok" || !body.result) {
          throw new Error("Unexpected health response")
        }
        if (!cancelled) setHealth({ kind: "ok", uptimeSeconds: body.result.uptimeSeconds })
      })
      .catch(() => {
        if (!cancelled) setHealth({ kind: "error" })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold" style={{ color: "var(--accent)" }}>
        Manifest
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Connect your data. Document what it means. Ask with evidence.
      </h1>
      <p className="mt-4 leading-7" style={{ color: "var(--muted)" }}>
        Manifest links your databases, keeps a living manifest of every table and column, and
        answers questions with the queries and rows behind them.
      </p>
      <div
        className="mt-8 rounded-lg border px-4 py-3 text-sm"
        style={{ borderColor: "var(--border)" }}
        role="status"
      >
        {health.kind === "loading" && "Checking the API…"}
        {health.kind === "ok" && `API is up (running for ${health.uptimeSeconds}s).`}
        {health.kind === "error" &&
          "API is unreachable. Start the backend, then refresh this page."}
      </div>
    </main>
  )
}
