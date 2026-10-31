import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"

import type {
  ConnectionManifest,
  ManifestObjectDetail,
  ManifestRefresh,
} from "../../../src/manifests/schemas.js"
import type { TestClient } from "./http.js"

interface Ok<T> {
  result: T
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"])

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read()
    if (done(value)) return value
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/** Manifest reads and refreshes for one source, as a given client. */
export function manifestClient(client: TestClient, manifestPath: string) {
  async function read<T>(path: string): Promise<T> {
    const res = await client.call<Ok<T>>(`${manifestPath}${path}`)
    assert.equal(res.status, 200, res.text)
    return res.body.result
  }

  async function finished(refreshId: string): Promise<ManifestRefresh> {
    return waitFor(
      () => read<ManifestRefresh>(`/refreshes/${refreshId}`),
      (refresh) => TERMINAL.has(refresh.status),
      `refresh ${refreshId}`,
    )
  }

  return {
    manifest: (search?: string) =>
      read<ConnectionManifest>(search === undefined ? "" : `?search=${encodeURIComponent(search)}`),
    detail: (objectId: string) => read<ManifestObjectDetail>(`/objects/${objectId}`),
    latestRefresh: () => read<ManifestRefresh | null>("/refreshes/latest"),
    finished,
    async refreshNow(): Promise<ManifestRefresh> {
      const res = await client.call<Ok<ManifestRefresh>>(`${manifestPath}/refresh`, { method: "POST" })
      assert.equal(res.status, 202, res.text)
      const done = await finished(res.body.result.id)
      assert.equal(done.status, "succeeded", done.error ?? "")
      return done
    },
  }
}

export function objectIdIn(published: ConnectionManifest, schema: string, name: string): string {
  const found = published.schemas
    .find((entry) => entry.name === schema)
    ?.objects.find((object) => object.name === name)
  assert.ok(found, `${schema}.${name} is listed`)
  return found.id
}
