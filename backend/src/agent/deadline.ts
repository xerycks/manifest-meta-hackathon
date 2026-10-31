/** Which limit ran out: the run's own, or the wait for the user's answer. */
export type DeadlineReason = "timeout" | "answer_timeout"

/**
 * A run's time limit. It pauses while the run waits for the user, who has a
 * separate limit to answer, and goes on with the time left once they do.
 * The signal aborts with the reason that ran out.
 */
export class RunDeadline {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private remaining: number
  private since = 0
  private timer: NodeJS.Timeout | undefined

  constructor(
    runMs: number,
    private readonly answerMs: number,
  ) {
    this.remaining = runMs
    this.arm(runMs, "timeout")
  }

  /** Stops the run's clock and starts the wait for an answer. */
  pause(): void {
    this.remaining -= Date.now() - this.since
    this.arm(this.answerMs, "answer_timeout")
  }

  /** Restarts the run's clock with the time it had left. */
  resume(): void {
    this.arm(Math.max(0, this.remaining), "timeout")
  }

  clear(): void {
    clearTimeout(this.timer)
  }

  private arm(ms: number, reason: DeadlineReason): void {
    clearTimeout(this.timer)
    this.since = Date.now()
    this.timer = setTimeout(() => this.controller.abort(reason), ms)
    this.timer.unref()
  }
}
