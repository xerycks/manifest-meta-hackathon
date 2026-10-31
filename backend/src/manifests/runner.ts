/** Why a run's signal was aborted from outside: a user cancel or a backend shutdown. */
export type StopReason = "cancelled" | "shutdown"

interface Job {
  controller: AbortController
  done: Promise<void>
}

/**
 * Runs refreshes in the background, at most `concurrency` at a time; the rest
 * wait for a slot. Each run can be aborted by id, and shutdown aborts them all
 * and waits until they have recorded how they ended.
 */
export class RefreshRunner {
  private readonly jobs = new Map<string, Job>()
  private readonly waiting = new Set<() => void>()
  private running = 0
  private stopped = false

  constructor(private readonly concurrency = 3) {}

  /**
   * Starts `task` once a slot is free. A run aborted while it waits still
   * starts, with its signal already aborted, so it can record the outcome.
   * `task` is expected to handle its own errors.
   */
  start(id: string, task: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    if (this.stopped) controller.abort("shutdown" satisfies StopReason)
    const done = this.acquire(controller.signal)
      .then(async (hasSlot) => {
        try {
          await task(controller.signal)
        } finally {
          if (hasSlot) this.release()
        }
      })
      .catch((error: unknown) => console.error(`Manifest refresh ${id} crashed`, error))
      .finally(() => this.jobs.delete(id))
    this.jobs.set(id, { controller, done })
  }

  /** Aborts a run in this process; false if it is not running here. */
  abort(id: string, reason: StopReason): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.controller.abort(reason)
    return true
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.controller.abort("shutdown" satisfies StopReason)
    await Promise.allSettled(jobs.map((job) => job.done))
  }

  private acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.running < this.concurrency) {
      this.running += 1
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", skip)
        this.waiting.delete(grant)
        this.running += 1
        resolve(true)
      }
      const skip = () => {
        this.waiting.delete(grant)
        resolve(false)
      }
      this.waiting.add(grant)
      signal.addEventListener("abort", skip, { once: true })
    })
  }

  private release(): void {
    this.running -= 1
    const next = this.waiting.values().next()
    if (!next.done) next.value()
  }
}
