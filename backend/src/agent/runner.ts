import { RunEventBus } from "./event-bus.js"

/** Why a run's signal was aborted from outside. */
export type AgentStopReason = "cancelled" | "shutdown"

/**
 * Runs answered at once (more fail fast instead of queueing), and event
 * streams a user may have open. Limits are per backend process.
 */
export const AGENT_CONCURRENCY = {
  perConversation: 1,
  perUser: 2,
  perWorkspace: 5,
  perProcess: 20,
  streamsPerUser: 10,
} as const

export interface AgentJob {
  runId: string
  workspaceId: string
  userId: string
  conversationId: string
}

/** Which limit refused a run. */
export type AgentBusy = "conversation" | "user" | "workspace" | "process"

/** A claimed place for a run: start it once it is recorded (resolving when it is done), or release it. */
export interface AgentSlot {
  start(task: (signal: AbortSignal) => Promise<void>): Promise<void>
  release(): void
}

interface Active extends AgentJob {
  controller: AbortController
  done: Promise<void> | null
}

/** Records the user's answer to a waiting run before the run goes on; must not throw. */
export type RecordAnswer = (answer: string) => Promise<void>

/**
 * Admits agent runs within per-conversation, per-user, per-workspace, and
 * per-process limits, tracks them so they can be cancelled or answered by id,
 * hands their events to the streams following them, and aborts them together
 * on shutdown. A run waiting for the user's answer keeps its place.
 */
export class AgentRunner {
  /** Recorded events of the runs in this process, for live streams. */
  readonly events = new RunEventBus()
  private readonly active = new Map<string, Active>()
  private readonly waiting = new Map<string, (answer: string) => Promise<void>>()
  private readonly streams = new Map<string, number>()
  /** Ends each open stream, so streams of runs that outlive the process do not hold it open. */
  private readonly following = new Set<() => void>()
  private stopped = false

  constructor(private readonly limits: typeof AGENT_CONCURRENCY = AGENT_CONCURRENCY) {}

  claim(job: AgentJob): AgentSlot | { busy: AgentBusy } {
    const runs = [...this.active.values()]
    const count = (matches: (run: Active) => boolean) => runs.filter(matches).length
    if (count((run) => run.conversationId === job.conversationId) >= this.limits.perConversation) {
      return { busy: "conversation" }
    }
    if (count((run) => run.userId === job.userId) >= this.limits.perUser) return { busy: "user" }
    if (count((run) => run.workspaceId === job.workspaceId) >= this.limits.perWorkspace) {
      return { busy: "workspace" }
    }
    if (runs.length >= this.limits.perProcess) return { busy: "process" }

    const active: Active = { ...job, controller: new AbortController(), done: null }
    this.active.set(job.runId, active)
    return {
      start: (task) => {
        if (this.stopped) active.controller.abort("shutdown" satisfies AgentStopReason)
        active.done = task(active.controller.signal)
          .catch((error: unknown) => console.error(`Agent run ${job.runId} failed unexpectedly`, error))
          .finally(() => this.active.delete(job.runId))
        return active.done
      },
      release: () => {
        if (!active.done) this.active.delete(job.runId)
      },
    }
  }

  /**
   * Counts an event stream the user opens; returns the function that counts
   * it closed (once), or null when the user already has as many open as allowed.
   * Shutdown calls `end` on each stream still open.
   */
  openStream(userId: string, end: () => void): (() => void) | null {
    const open = this.streams.get(userId) ?? 0
    if (open >= this.limits.streamsPerUser) return null
    this.streams.set(userId, open + 1)
    this.following.add(end)
    let closed = false
    return () => {
      if (closed) return
      closed = true
      this.following.delete(end)
      const left = (this.streams.get(userId) ?? 1) - 1
      if (left > 0) this.streams.set(userId, left)
      else this.streams.delete(userId)
    }
  }

  /** Shutdown has begun: streams opened now end once they have caught up. */
  get stopping(): boolean {
    return this.stopped
  }

  /** Aborts a run and waits until it has recorded how it ended; false if it is not running here. */
  async cancel(runId: string): Promise<boolean> {
    const active = this.active.get(runId)
    if (!active) return false
    active.controller.abort("cancelled" satisfies AgentStopReason)
    await active.done
    return true
  }

  /**
   * Waits for the user's answer to the run's clarification. When it arrives,
   * `record` runs before the answer reaches the run (and before answer()
   * returns). Rejects with the abort reason if the run stops first.
   */
  waitForAnswer(runId: string, signal: AbortSignal, record: RecordAnswer): Promise<string> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        this.waiting.delete(runId)
        reject(signal.reason)
      }
      if (signal.aborted) {
        stop()
        return
      }
      signal.addEventListener("abort", stop, { once: true })
      this.waiting.set(runId, async (answer) => {
        signal.removeEventListener("abort", stop)
        await record(answer)
        resolve(answer)
      })
    })
  }

  /** Gives a waiting run its answer once recorded; false when no run here is waiting for one. */
  async answer(runId: string, answer: string): Promise<boolean> {
    const deliver = this.waiting.get(runId)
    if (!deliver) return false
    this.waiting.delete(runId)
    await deliver(answer)
    return true
  }

  /**
   * Stops the runs here (they record how they ended), then ends the streams
   * still open: they follow waiting runs, which go on after the restart, and
   * their clients reconnect to the next process.
   */
  async shutdown(): Promise<void> {
    this.stopped = true
    const runs = [...this.active.values()]
    for (const run of runs) run.controller.abort("shutdown" satisfies AgentStopReason)
    await Promise.allSettled(runs.map((run) => run.done))
    for (const end of [...this.following]) end()
  }
}
