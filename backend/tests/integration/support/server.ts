import assert from "node:assert/strict"
import type { Server } from "node:http"

import type { Express } from "express"

export interface RunningApp {
  baseUrl: string
  close(): Promise<void>
}

/** Listens on an ephemeral loopback port. */
export async function startApp(app: Express): Promise<RunningApp> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening))
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
