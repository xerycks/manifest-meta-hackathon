import { setTimeout as sleep } from "node:timers/promises"

import { AppError } from "../shared/http/errors.js"

export interface DispatcherOptions {
  /** How often due routines are claimed. */
  intervalMs: number
  /**
   * Routine runs this process works on at once; a tick claims only what fits,
   * and a manual run is refused (429) when none fits.
   */
  concurrency: number
  /** The first wait after a run is refused for lack of a slot (429); later waits double up to maxDelayMs. */
  firstDelayMs: number
  maxDelayMs: number
  /** How long a refused run keeps retrying before it fails. */
  busyTimeoutMs: number
  /** The clock schedules are read with; tests move it. */
  now: () => number
}

export const DISPATCHER_OPTIONS: DispatcherOptions = {
  intervalMs: 15_000,
  concurrency: 4,
  firstDelayMs: 500,
  maxDelayMs: 5_000,
  busyTimeoutMs: 60_000,
  now: Date.now,
}

/** Why the dispatcher's signal was aborted. */
export const SHUTDOWN = "shutdown"

/** What a tick does: claims up to `limit` due routines and starts their runs through launch(). */
export interface DispatchTarget {
  dispatch(limit: number): Promise<void>
}

/**
 * Runs routines in this backend process: every interval it has the routines
 * service claim the routines that are due (in storage, so several processes
 * can tick at once without running a slot twice), within its free capacity,
 * and it tracks the runs it starts so a shutdown can stop them and wait until
 * each has recorded how it ended.
 */
export class RoutineDispatcher {
  readonly options: DispatcherOptions
  private target: DispatchTarget | null = null
  private readonly active = new Map<string, Promise<void>>()
  private readonly stopping = new AbortController()
  private timer: NodeJS.Timeout | null = null
  private ticking: Promise<void> | null = null

  constructor(options: Partial<DispatcherOptions> = {}) {
    this.options = { ...DISPATCHER_OPTIONS, ...options }
  }

  now(): number {
    return this.options.now()
  }

  /** Set when the app is composed: the routines service claims and runs what is due. */
  attach(target: DispatchTarget): void {
    this.target = target
  }

  /** Claims due routines now and then every intervalMs, until stop(). */
  start(): void {
    if (this.timer !== null || this.stopping.signal.aborted) return
    const loop = () => {
      void this.tick().finally(() => {
        if (this.stopping.signal.aborted) return
        this.timer = setTimeout(loop, this.options.intervalMs)
        this.timer.unref()
      })
    }
    this.timer = setTimeout(loop, 0)
    this.timer.unref()
  }

  /** Claims what is due within the free capacity; a tick already under way is joined, not repeated. */
  tick(): Promise<void> {
    this.ticking ??= this.claim().finally(() => {
      this.ticking = null
    })
    return this.ticking
  }

  /** Runs a routine run here; `signal` aborts with SHUTDOWN when the dispatcher stops. */
  launch(runId: string, task: (signal: AbortSignal) => Promise<void>): void {
    const done = task(this.stopping.signal)
      .catch((error: unknown) => console.error(`Routine run ${runId} failed unexpectedly`, error))
      .finally(() => this.active.delete(runId))
    this.active.set(runId, done)
  }

  /** Runs being worked on here. */
  get running(): number {
    return this.active.size
  }

  /** Takes no more runs now: it is stopping, or works on as many as it may. */
  get full(): boolean {
    return this.stopping.signal.aborted || this.active.size >= this.options.concurrency
  }

  /**
   * Claims nothing more and aborts the runs' signal, so runs waiting for a
   * slot give up; resolves once a claim under way has committed. Runs already
   * on a source or with the agent end when those runners shut down.
   */
  async stop(): Promise<void> {
    this.stopping.abort(SHUTDOWN)
    if (this.timer !== null) clearTimeout(this.timer)
    await this.ticking
  }

  /** Resolves once every run started here has recorded how it ended. */
  async drained(): Promise<void> {
    await Promise.allSettled([...this.active.values()])
  }

  private async claim(): Promise<void> {
    const free = this.options.concurrency - this.active.size
    if (this.stopping.signal.aborted || !this.target || free <= 0) return
    try {
      await this.target.dispatch(free)
    } catch (error) {
      console.error("Could not claim due routines", error)
    }
  }
}

/**
 * Runs `task`, retrying with backoff while it is refused for lack of a slot
 * (429 QUERY_BUSY or AGENT_BUSY), for at most busyTimeoutMs. Gives up with the
 * last refusal, or once `signal` aborts.
 */
export async function retryWhileBusy<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
  options: Pick<DispatcherOptions, "firstDelayMs" | "maxDelayMs" | "busyTimeoutMs">,
): Promise<T> {
  const giveUpAt = Date.now() + options.busyTimeoutMs
  let delay = options.firstDelayMs
  for (;;) {
    try {
      return await task()
    } catch (error) {
      const busy = error instanceof AppError && error.status === 429
      if (!busy || signal.aborted || Date.now() + delay > giveUpAt) throw error
      await sleep(delay, undefined, { signal }).catch(() => {})
      if (signal.aborted) throw error
      delay = Math.min(delay * 2, options.maxDelayMs)
    }
  }
}
