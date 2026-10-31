import type { RunEvent } from "./contracts.js"

export type RunEventListener = (event: RunEvent) => void

/**
 * Hands each recorded run event to the streams following that run, in this
 * backend process. Listeners must not throw; a stream that has gone away
 * unsubscribes.
 */
export class RunEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>()

  subscribe(runId: string, listener: RunEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && this.listeners.get(runId) === listeners) this.listeners.delete(runId)
    }
  }

  publish(runId: string, event: RunEvent): void {
    for (const listener of this.listeners.get(runId) ?? []) listener(event)
  }

  /** Streams following a run; for tests and diagnostics. */
  followers(runId: string): number {
    return this.listeners.get(runId)?.size ?? 0
  }
}
