import type { Response } from "express"

/** Heartbeats sent this often keep proxies and browsers from closing an idle stream. */
export const HEARTBEAT_MS = 15_000
/**
 * A comment for proxies, plus a named event (which EventSource hands only to
 * "heartbeat" listeners) so a browser can tell a quiet stream from a dead one.
 */
const HEARTBEAT = ": heartbeat\nevent: heartbeat\ndata: {}\n\n"
/** How long a browser waits before reconnecting a dropped stream. */
const RETRY_MS = 2_000

/**
 * A Server-Sent Events response. It opens (status and headers) on the first
 * write, so a request refused before then still gets a JSON error. Nothing
 * buffers or compresses it, and it stops writing once the client has gone.
 */
export class EventStream {
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private readonly onClosed: (() => void)[] = []

  constructor(
    private readonly res: Response,
    private readonly heartbeatMs = HEARTBEAT_MS,
  ) {
    res.on("close", () => this.close())
  }

  get opened(): boolean {
    return this.res.headersSent
  }

  open(): void {
    if (this.res.headersSent || this.closed) return
    this.res.status(200)
    this.res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tells reverse proxies such as nginx not to buffer the stream.
      "X-Accel-Buffering": "no",
    })
    this.res.flushHeaders()
    this.res.write(`retry: ${RETRY_MS}\n\n`)
    this.timer = setInterval(() => this.res.write(HEARTBEAT), this.heartbeatMs)
  }

  /** One event; `data` is sent as JSON on a single line. */
  send(id: string, data: unknown): void {
    if (this.closed) return
    this.open()
    this.res.write(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  end(): void {
    if (this.closed) return
    this.open()
    this.close()
    this.res.end()
  }

  /** Runs `callback` once the stream has closed (at once if it already has). */
  whenClosed(callback: () => void): void {
    if (this.closed) callback()
    else this.onClosed.push(callback)
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    for (const callback of this.onClosed.splice(0)) callback()
  }
}
