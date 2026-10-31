import assert from "node:assert/strict"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import type { GoogleProvider } from "../../src/auth/google.js"
import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { signIn, TestClient, type SessionContext } from "./support/http.js"
import { startApp, type RunningApp } from "./support/server.js"
import { migrationNames, resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const skip = !TEST_DATABASE_URL
const SECRET = "integration-test-secret-at-least-32-chars"

const fakeGoogle: GoogleProvider = {
  authorizationUrl: ({ state }) => `https://google.example/auth?state=${state}`,
  createPkce: async () => ({ verifier: "fake-verifier", challenge: "fake-challenge" }),
  exchange: async ({ code, verifier }) => {
    assert.equal(verifier, "fake-verifier")
    if (code !== "good-code") throw new Error("bad code")
    return { email: "grace@example.com", name: "Grace", googleSubject: "google-sub-1" }
  },
}

let pool: Pool
let running: RunningApp

async function devLogin(email: string, name = ""): Promise<TestClient> {
  return (await signIn(running.baseUrl, email, name)).client
}

interface ContextBody {
  result: SessionContext
}

before(async () => {
  if (!TEST_DATABASE_URL) return
  pool = createPool(TEST_DATABASE_URL)
  assert.deepEqual(await resetStorage(pool), migrationNames())
  const env = loadEnv({ NODE_ENV: "test", ALLOW_DEV_LOGIN: "true", SESSION_SECRET: SECRET })
  running = await startApp(createApp(env, { pool, googleProvider: fakeGoogle }))
})

after(async () => {
  if (!TEST_DATABASE_URL) return
  await running.close()
  await pool.end()
})

test("unauthenticated requests are rejected with 401", { skip }, async () => {
  const anon = new TestClient(running.baseUrl)
  const context = await anon.call<{ error: { code: string } }>("/api/v1/context")
  assert.equal(context.status, 401)
  assert.equal(context.body.error.code, "UNAUTHORIZED")

  const workspaces = await anon.call("/api/v1/workspaces")
  assert.equal(workspaces.status, 401)
})

test("dev sign-in, CSRF, owner membership, and sign-out", { skip }, async () => {
  const ada = await devLogin("ada@example.com", "Ada")

  // Mutation without CSRF is rejected even with a valid session cookie.
  const noCsrf = await ada.call<{ error: { code: string } }>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
    csrf: false,
  })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")

  const created = await ada.call<{ result: Workspace & { role: string } }>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.result.role, "owner")

  const context = await ada.call<ContextBody>("/api/v1/context")
  assert.equal(context.body.result.user.email, "ada@example.com")
  assert.equal(context.body.result.memberships[0]?.slug, "acme")

  const signOut = await ada.call("/api/v1/session", { method: "DELETE" })
  assert.equal(signOut.status, 200)
  const afterOut = await ada.call("/api/v1/context")
  assert.equal(afterOut.status, 401)
})

test("members can read but not write settings; non-members see 404", { skip }, async () => {
  const ada = await devLogin("ada@example.com")
  const context = await ada.call<ContextBody>("/api/v1/context")
  const acme = context.body.result.memberships.find((m) => m.slug === "acme")
  assert.ok(acme)

  const ben = await devLogin("ben@example.com", "Ben")
  const benContext = await ben.call<ContextBody>("/api/v1/context")
  const benId = benContext.body.result.user.id

  // Non-member: indistinguishable from a missing workspace.
  const hidden = await ben.call(`/api/v1/workspaces/${acme.id}/settings`)
  assert.equal(hidden.status, 404)

  await new WorkspacesRepository(pool).addMember(acme.id, benId, "member")

  const setByOwner = await ada.call(`/api/v1/workspaces/${acme.id}/settings/description`, {
    method: "PUT",
    json: { value: "Owner wrote this" },
  })
  assert.equal(setByOwner.status, 200)

  const readByMember = await ben.call<{ result: { value: unknown } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
  )
  assert.equal(readByMember.status, 200)
  assert.equal(readByMember.body.result.value, "Owner wrote this")

  const writeByMember = await ben.call<{ error: { code: string } }>(
    `/api/v1/workspaces/${acme.id}/settings/description`,
    { method: "PUT", json: { value: "Member overwrite" } },
  )
  assert.equal(writeByMember.status, 403)
  assert.equal(writeByMember.body.error.code, "FORBIDDEN")
})

test("expired sessions are rejected and removed", { skip }, async () => {
  const eve = await devLogin("eve@example.com")
  await pool.query(
    `UPDATE sessions SET expires_at = now() - interval '1 minute'
      WHERE user_id = (SELECT id FROM users WHERE email = 'eve@example.com')`,
  )
  const res = await eve.call<{ error: { code: string } }>("/api/v1/context")
  assert.equal(res.status, 401)
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sessions
      WHERE user_id = (SELECT id FROM users WHERE email = 'eve@example.com')`,
  )
  assert.equal(rows[0]?.count, "0")
})

test("google sign-in round-trip with a fake provider; attempts are single-use", { skip }, async () => {
  const client = new TestClient(running.baseUrl)
  const startRes = await client.call("/api/v1/auth/google?returnTo=/manifests")
  assert.equal(startRes.status, 302)
  const location = startRes.headers.get("location") ?? ""
  const state = new URL(location).searchParams.get("state")
  assert.ok(state)
  assert.ok(client.cookies.has("manifest_google_attempt"))

  const callback = `/api/v1/auth/google/callback?state=${state}&code=good-code`
  const done = await client.call(callback)
  assert.equal(done.status, 303)
  assert.equal(new URL(done.headers.get("location") ?? "").pathname, "/manifests")
  assert.ok(client.cookies.has("manifest_session"))

  const context = await client.call<ContextBody>("/api/v1/context")
  assert.equal(context.body.result.user.email, "grace@example.com")

  // Replaying the same callback must not mint another session.
  const replay = new TestClient(running.baseUrl)
  replay.cookies.set(
    "manifest_google_attempt",
    client.cookies.get("manifest_google_attempt") ?? "",
  )
  const replayed = await replay.call(callback)
  assert.equal(replayed.status, 303)
  assert.match(replayed.headers.get("location") ?? "", /auth_error=google_account_rejected/)
})

test("auth config reports google and dev availability without secrets", { skip }, async () => {
  const anon = new TestClient(running.baseUrl)
  const res = await anon.call<{ result: { google: boolean; devLogin: boolean } }>(
    "/api/v1/auth/config",
  )
  assert.equal(res.body.result.google, true)
  assert.equal(res.body.result.devLogin, true)
  assert.ok(!JSON.stringify(res.body).includes(SECRET))
})
