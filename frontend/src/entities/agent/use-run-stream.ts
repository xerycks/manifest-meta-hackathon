import { useEffect, useRef, useState } from "react"

import { fetchRun, runEventsUrl } from "./api.ts"
import { followRun, type StreamState } from "./run-stream.ts"
import type { AgentRunWithEvents, RunEvent } from "./types.ts"

/**
 * Follows a run's events from sequence `from` over Server-Sent Events,
 * catching up and reconnecting after drops and silences (see followRun).
 * `attempt` restarts a lost stream when it changes.
 */
export function useRunStream({
  workspaceId,
  runId,
  from,
  attempt = 0,
  onEvents,
  onRun,
}: {
  workspaceId: string | null
  /** Null: nothing to follow. */
  runId: string | null
  from: number
  attempt?: number
  onEvents: (runId: string, events: RunEvent[]) => void
  /** A fresh read of the run, taken while reconnecting. */
  onRun: (run: AgentRunWithEvents) => void
}): { state: StreamState; problem: string | null } {
  const [state, setState] = useState<StreamState>("connecting")
  const [problem, setProblem] = useState<string | null>(null)
  const latest = useRef({ onEvents, onRun, from })
  // Declared first, so the stream below always sees the current handlers and position.
  useEffect(() => {
    latest.current = { onEvents, onRun, from }
  })

  useEffect(() => {
    if (!workspaceId || !runId) return
    return followRun({
      from: latest.current.from,
      open(after, on) {
        const source = new EventSource(runEventsUrl(workspaceId, runId, after), { withCredentials: true })
        source.onopen = () => on.open()
        source.onmessage = (message: MessageEvent<string>) => on.message(message.data)
        source.addEventListener("heartbeat", () => on.heartbeat())
        source.onerror = () => on.error()
        return source
      },
      read: (after) => fetchRun(workspaceId, runId, after),
      onEvents: (events) => latest.current.onEvents(runId, events),
      onRun: (run) => latest.current.onRun(run),
      onState(next, reason) {
        setState(next)
        setProblem(reason ?? null)
      },
    })
  }, [workspaceId, runId, attempt])

  return { state: runId ? state : "ended", problem }
}
