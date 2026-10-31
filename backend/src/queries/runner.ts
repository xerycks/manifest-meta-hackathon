/** Why a running query's signal was aborted from outside. */
export type QueryStopReason = "cancelled" | "shutdown"

/** Concurrent queries allowed at once; anything beyond fails fast instead of queueing. */
export const QUERY_CONCURRENCY = { perSource: 2, perWorkspace: 4, perProcess: 16 } as const

export interface QueryJob {
  id: string
  workspaceId: string
  connectionId: string
  userId: string | null
}

interface Running extends QueryJob {
  controller: AbortController
  done: Promise<unknown>
}

const increment = (counts: Map<string, number>, key: string, by: number) => {
  const next = (counts.get(key) ?? 0) + by
  if (next > 0) counts.set(key, next)
  else counts.delete(key)
}

/**
 * Admits queries within per-source, per-workspace, and per-process limits
 * and tracks the running ones, so they can be cancelled by id and aborted
 * together on shutdown. Limits are per backend process.
 */
export class QueryRunner {
  private readonly running = new Map<string, Running>()
  private readonly perSource = new Map<string, number>()
  private readonly perWorkspace = new Map<string, number>()
  private stopped = false

  constructor(private readonly limits: typeof QUERY_CONCURRENCY = QUERY_CONCURRENCY) {}

  /**
   * Runs `task` in a free slot, or returns null without running it when a
   * limit is reached. While the backend shuts down, tasks start with an
   * aborted signal so they can record how they ended.
   */
  run<T>(job: QueryJob, task: (signal: AbortSignal) => Promise<T>): Promise<T> | null {
    const key = this.key(job.workspaceId, job.id)
    if (
      this.running.has(key) ||
      this.running.size >= this.limits.perProcess ||
      (this.perWorkspace.get(job.workspaceId) ?? 0) >= this.limits.perWorkspace ||
      (this.perSource.get(job.connectionId) ?? 0) >= this.limits.perSource
    ) {
      return null
    }
    const controller = new AbortController()
    if (this.stopped) controller.abort("shutdown" satisfies QueryStopReason)
    increment(this.perSource, job.connectionId, 1)
    increment(this.perWorkspace, job.workspaceId, 1)
    const done = task(controller.signal).finally(() => {
      this.running.delete(key)
      increment(this.perSource, job.connectionId, -1)
      increment(this.perWorkspace, job.workspaceId, -1)
    })
    this.running.set(key, { ...job, controller, done })
    return done
  }

  /** A query running in this process. */
  find(workspaceId: string, id: string): QueryJob | undefined {
    return this.running.get(this.key(workspaceId, id))
  }

  /** Aborts a running query and waits until it has recorded how it ended; false if it is not running here. */
  async cancel(workspaceId: string, id: string): Promise<boolean> {
    const running = this.running.get(this.key(workspaceId, id))
    if (!running) return false
    running.controller.abort("cancelled" satisfies QueryStopReason)
    await running.done.catch(() => {})
    return true
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const jobs = [...this.running.values()]
    for (const job of jobs) job.controller.abort("shutdown" satisfies QueryStopReason)
    await Promise.allSettled(jobs.map((job) => job.done))
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}/${id}`
  }
}
