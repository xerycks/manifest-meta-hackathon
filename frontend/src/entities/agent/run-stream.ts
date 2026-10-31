// Follows a run's events over Server-Sent Events. When the connection drops
// or goes silent, it catches up by reading the run (which also tells whether
// the run has ended or is gone), then reconnects after the last event
// received, so nothing is missed or applied twice.

import { ApiError } from "../../shared/api/client.ts"
import { isActive } from "./timeline.ts"
import { TERMINAL_EVENT_TYPES, type AgentRunWithEvents, type RunEvent } from "./types.ts"

/**
 * connecting: opening the stream; live: events arrive as they happen;
 * reconnecting: the connection dropped and is being restored; ended: the run
 * finished; lost: the run cannot be followed (gone, or access ended).
 */
export type StreamState = "connecting" | "live" | "reconnecting" | "ended" | "lost"

/** What an open stream reports: an EventSource's open, message, "heartbeat", and error events. */
export interface StreamHandlers {
  open(): void
  message(data: string): void
  heartbeat(): void
  error(): void
}

export interface FollowRunOptions {
  /** The last event already applied; the stream starts after it. */
  from: number
  /** Opens the run's event stream after sequence `after`. */
  open(after: number, on: StreamHandlers): { close(): void }
  /** Reads the run with its events after sequence `after`. */
  read(after: number): Promise<AgentRunWithEvents>
  onEvents(events: RunEvent[]): void
  /** A fresh read of the run, taken while reconnecting. */
  onRun(run: AgentRunWithEvents): void
  onState(state: StreamState, problem?: string): void
}

/** Waits between reconnection attempts: 1 s, 2 s, 4 s, 8 s, then every 10 s. */
export const reconnectDelay = (attempt: number) => Math.min(1_000 * 2 ** attempt, 10_000)

/**
 * The server sends a heartbeat every 15 s. A stream silent for longer than
 * this is treated as dropped: a proxy or network can leave a dead connection
 * looking open, and the browser never reports it.
 */
export const SILENCE_MS = 40_000

/** Starts following a run; returns a function that stops. */
export function followRun(options: FollowRunOptions): () => void {
  let last = options.from
  let connection: { close(): void } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let stopped = false

  const finish = (state: StreamState, problem?: string) => {
    stopped = true
    clearTimeout(watchdog)
    connection?.close()
    options.onState(state, problem)
  }

  const retry = () => {
    timer = setTimeout(() => void recover(), reconnectDelay(failures++))
  }

  // Takes over reconnecting from the browser, so the run can be checked first.
  const dropped = () => {
    clearTimeout(watchdog)
    connection?.close()
    if (stopped) return
    options.onState("reconnecting")
    retry()
  }

  const alive = () => {
    clearTimeout(watchdog)
    if (!stopped) watchdog = setTimeout(dropped, SILENCE_MS)
  }

  const connect = () => {
    connection = options.open(last, {
      open() {
        failures = 0
        alive()
        options.onState("live")
      },
      message(data) {
        const event = JSON.parse(data) as RunEvent
        if (stopped) return
        alive()
        if (event.seq <= last) return
        last = event.seq
        options.onEvents([event])
        if (TERMINAL_EVENT_TYPES.includes(event.type)) finish("ended")
      },
      heartbeat: alive,
      error: dropped,
    })
    alive()
  }

  const recover = async () => {
    try {
      const run = await options.read(last)
      if (stopped) return
      options.onRun(run)
      last = Math.max(last, ...run.events.map((event) => event.seq))
      if (isActive(run.status)) connect()
      else finish("ended")
    } catch (error) {
      if (stopped) return
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) finish("lost", error.message)
      else retry()
    }
  }

  options.onState("connecting")
  connect()
  return () => {
    stopped = true
    connection?.close()
    clearTimeout(timer)
    clearTimeout(watchdog)
  }
}
