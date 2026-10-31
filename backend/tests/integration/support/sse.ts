import type { TestClient } from "./http.js"

/** One Server-Sent Events frame: an event (id, type, and data), a comment, or both (a heartbeat). */
export interface SseFrame {
  id?: string
  event?: string
  data?: string
  comment?: string
  retry?: string
}

const WAIT_MS = 15_000

/**
 * Reads an event stream as a browser would, collecting its frames. Aborting
 * `close()` drops the connection, like leaving the page.
 */
export class SseReader {
  readonly frames: SseFrame[] = []
  ended = false
  private wake: (() => void) | null = null

  constructor(
    readonly response: Response,
    private readonly controller: AbortController,
  ) {
    void this.pump()
  }

  /** The parsed data of each run event received so far (unnamed events, as EventSource's onmessage gets them). */
  events<T = { seq: number; type: string; data: unknown }>(): T[] {
    return this.frames.flatMap((frame) =>
      frame.data === undefined || frame.event !== undefined ? [] : [JSON.parse(frame.data) as T],
    )
  }

  /** Resolves once `ready` holds for the frames received, or the stream ends. */
  async until(ready: (reader: SseReader) => boolean, label: string, timeoutMs = WAIT_MS): Promise<void> {
    const started = Date.now()
    while (!ready(this)) {
      if (this.ended) throw new Error(`The stream ended before ${label}`)
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
      await new Promise<void>((resolve) => {
        this.wake = resolve
        setTimeout(resolve, 100)
      })
    }
  }

  close(): void {
    this.controller.abort()
  }

  private async pump(): Promise<void> {
    const reader = this.response.body?.getReader()
    if (!reader) return
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          this.frames.push(parseFrame(buffer.slice(0, boundary)))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf("\n\n")
        }
        this.wake?.()
      }
    } catch {
      // Closed by the test.
    } finally {
      this.ended = true
      this.wake?.()
    }
  }
}

function parseFrame(block: string): SseFrame {
  const frame: SseFrame = {}
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) frame.comment = line.slice(1).trim()
    else {
      const colon = line.indexOf(":")
      const field = line.slice(0, colon)
      const value = line.slice(colon + 1).replace(/^ /, "")
      if (field === "id" || field === "event" || field === "data" || field === "retry") frame[field] = value
    }
  }
  return frame
}

/** Opens an event stream with the client's session, as EventSource does. */
export async function openStream(
  client: TestClient,
  path: string,
  headers: Record<string, string> = {},
): Promise<SseReader> {
  const controller = new AbortController()
  const cookie = [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  const response = await fetch(`${client.baseUrl}${path}`, {
    headers: { Accept: "text/event-stream", ...(cookie ? { Cookie: cookie } : {}), ...headers },
    signal: controller.signal,
  })
  return new SseReader(response, controller)
}
