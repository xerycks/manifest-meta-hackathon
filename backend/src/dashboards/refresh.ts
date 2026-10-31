import { setTimeout as sleep } from "node:timers/promises"

import { AppError } from "../shared/http/errors.js"
import type { RefreshFailure } from "./schemas.js"

export interface RefreshOptions {
  /** Saved queries one dashboard refresh runs at once; admission allows 2 per source and 4 per workspace. */
  concurrency: number
  /** The first wait after admission refuses a run (429 QUERY_BUSY); each later wait doubles, up to maxDelayMs. */
  firstDelayMs: number
  maxDelayMs: number
  /** How long a run keeps waiting for a free slot before it fails. */
  busyTimeoutMs: number
}

export const REFRESH_OPTIONS: RefreshOptions = {
  concurrency: 2,
  firstDelayMs: 500,
  maxDelayMs: 5_000,
  busyTimeoutMs: 60_000,
}

/** Failures of runs that left no execution record behind (e.g. never admitted), kept for reporting. */
const KEPT_FAILURES = 1_000

export interface RefreshTask {
  savedQueryId: string
  /** Runs the saved query once; aborting `signal` cancels it. Throws AppError when it cannot run. */
  run: (signal: AbortSignal) => Promise<unknown>
}

/** One run of a saved query that every refresh asking for it meanwhile waits on. */
interface Flight {
  controller: AbortController
  startedAt: number
  /** Refreshes waiting on it; cancelling the last of them aborts it. */
  waiters: Set<string>
  done: Promise<void>
}

interface Refresh {
  startedAt: number
  queue: RefreshTask[]
  /** Saved queries this refresh has queued, run, or joined; asking again while it lasts adds nothing. */
  included: Set<string>
  workers: number
}

export interface RefreshProgress {
  active: boolean
  startedAt: string | null
  /** Saved queries running now (for whichever dashboard), with since when, or queued in this refresh (null). */
  refreshing: Map<string, string | null>
  /** The latest failure of each saved query that was not followed by another run here. */
  failures: Map<string, RefreshFailure>
}

const iso = (time: number) => new Date(time).toISOString()

const CANCELLED = {
  code: "QUERY_CANCELLED",
  message: "The refresh was cancelled before this query finished.",
}
const GAVE_UP = {
  code: "QUERY_BUSY",
  message: "Too many queries kept running on this source to refresh this panel. Try again in a minute.",
}

function failureOf(error: unknown): Omit<RefreshFailure, "at"> {
  if (error instanceof AppError) return { code: error.code, message: error.message }
  console.error("A dashboard refresh run failed unexpectedly", error)
  return {
    code: "INTERNAL_ERROR",
    message: "The refresh failed unexpectedly. Try again; if it keeps failing, check the backend logs.",
  }
}

/**
 * Coordinates dashboard refreshes within this backend process. Each refresh
 * runs its saved queries a few at a time; a saved query already running (for
 * another panel, refresh, or dashboard) is joined rather than run again; a
 * run refused for lack of a slot waits and retries with backoff; and
 * cancelling a refresh aborts the runs no other refresh is waiting on.
 */
export class DashboardRefresher {
  private readonly flights = new Map<string, Flight>()
  private readonly refreshes = new Map<string, Refresh>()
  private readonly failures = new Map<string, RefreshFailure>()
  private stopped = false

  constructor(private readonly options: RefreshOptions = REFRESH_OPTIONS) {}

  /**
   * Starts a refresh of the dashboard with these runs, or adds them to the
   * one already running, which skips saved queries it has already refreshed.
   */
  start(workspaceId: string, dashboardId: string, tasks: RefreshTask[]): void {
    if (this.stopped || tasks.length === 0) return
    const key = `${workspaceId}/${dashboardId}`
    let refresh = this.refreshes.get(key)
    if (!refresh) {
      refresh = { startedAt: Date.now(), queue: [], included: new Set(), workers: 0 }
      this.refreshes.set(key, refresh)
    }
    for (const task of tasks) {
      if (refresh.included.has(task.savedQueryId)) continue
      refresh.included.add(task.savedQueryId)
      refresh.queue.push(task)
    }
    while (refresh.workers < this.options.concurrency && refresh.queue.length > 0) {
      refresh.workers += 1
      void this.work(workspaceId, key, refresh)
    }
  }

  /**
   * Cancels the dashboard's refresh: queued runs are dropped and running ones
   * aborted unless another refresh waits on them. Resolves once the aborted
   * runs have stopped; false when no refresh was running.
   */
  async cancel(workspaceId: string, dashboardId: string): Promise<boolean> {
    const key = `${workspaceId}/${dashboardId}`
    const refresh = this.refreshes.get(key)
    if (!refresh) return false
    this.refreshes.delete(key)
    refresh.queue.length = 0
    const stopping: Promise<void>[] = []
    for (const flight of this.flights.values()) {
      if (!flight.waiters.delete(key) || flight.waiters.size > 0) continue
      flight.controller.abort("cancelled")
      stopping.push(flight.done)
    }
    await Promise.all(stopping)
    return true
  }

  progress(workspaceId: string, dashboardId: string, savedQueryIds: string[]): RefreshProgress {
    const refresh = this.refreshes.get(`${workspaceId}/${dashboardId}`)
    const refreshing = new Map<string, string | null>()
    const failures = new Map<string, RefreshFailure>()
    for (const id of savedQueryIds) {
      const key = `${workspaceId}/${id}`
      const flight = this.flights.get(key)
      if (flight) refreshing.set(id, iso(flight.startedAt))
      else if (refresh?.queue.some((task) => task.savedQueryId === id)) refreshing.set(id, null)
      const failure = this.failures.get(key)
      if (failure) failures.set(id, failure)
    }
    return {
      active: refresh !== undefined,
      startedAt: refresh ? iso(refresh.startedAt) : null,
      refreshing,
      failures,
    }
  }

  /** Stops every refresh; runs record how they ended before this resolves. */
  async shutdown(): Promise<void> {
    this.stopped = true
    for (const refresh of this.refreshes.values()) refresh.queue.length = 0
    this.refreshes.clear()
    const flights = [...this.flights.values()]
    for (const flight of flights) flight.controller.abort("shutdown")
    await Promise.all(flights.map((flight) => flight.done))
  }

  private async work(workspaceId: string, key: string, refresh: Refresh): Promise<void> {
    for (let task = refresh.queue.shift(); task; task = refresh.queue.shift()) {
      await this.join(workspaceId, key, refresh, task)
    }
    refresh.workers -= 1
    if (refresh.workers === 0 && this.refreshes.get(key) === refresh) this.refreshes.delete(key)
  }

  /**
   * Waits for the saved query's run in flight, starting one if none is. A run
   * being cancelled is not joined: once it has stopped, a new one starts,
   * unless this refresh was cancelled meanwhile.
   */
  private async join(
    workspaceId: string,
    refreshKey: string,
    refresh: Refresh,
    task: RefreshTask,
  ): Promise<void> {
    const key = `${workspaceId}/${task.savedQueryId}`
    let flight = this.flights.get(key)
    while (flight?.controller.signal.aborted) {
      await flight.done
      if (this.refreshes.get(refreshKey) !== refresh) return
      flight = this.flights.get(key)
    }
    if (!flight) {
      const controller = new AbortController()
      const started: Flight = {
        controller,
        startedAt: Date.now(),
        waiters: new Set(),
        done: Promise.resolve(),
      }
      started.done = this.fly(key, task, controller.signal).finally(() => {
        if (this.flights.get(key) === started) this.flights.delete(key)
      })
      this.flights.set(key, started)
      flight = started
    }
    flight.waiters.add(refreshKey)
    await flight.done
  }

  /** Runs the task, retrying while admission refuses it; never rejects. */
  private async fly(key: string, task: RefreshTask, signal: AbortSignal): Promise<void> {
    this.failures.delete(key)
    const giveUpAt = Date.now() + this.options.busyTimeoutMs
    let delay = this.options.firstDelayMs
    for (;;) {
      // A run that started records its own end; one cancelled before it could start is noted here.
      if (signal.aborted) return this.fail(key, CANCELLED)
      try {
        await task.run(signal)
        return
      } catch (error) {
        if (signal.aborted) return this.fail(key, CANCELLED)
        const busy = error instanceof AppError && error.code === "QUERY_BUSY"
        if (!busy) return this.fail(key, failureOf(error))
        if (Date.now() + delay > giveUpAt) return this.fail(key, GAVE_UP)
        await sleep(delay, undefined, { signal }).catch(() => {})
        delay = Math.min(delay * 2, this.options.maxDelayMs)
      }
    }
  }

  private fail(key: string, failure: Omit<RefreshFailure, "at">): void {
    this.failures.delete(key)
    this.failures.set(key, { ...failure, at: new Date().toISOString() })
    if (this.failures.size > KEPT_FAILURES) {
      const oldest = this.failures.keys().next().value
      if (oldest !== undefined) this.failures.delete(oldest)
    }
  }
}
