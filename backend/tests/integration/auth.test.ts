import assert from "node:assert/strict"
import type { Server } from "node:http"
import test, { after, before } from "node:test"

import type { Express } from "express"
import type { Pool } from "pg"

import type { GoogleProvider } from "../../src/auth/google.js"
import { loadEnv } from "../../src/config/env.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { runMigrations } from "../../src/storage/migrations.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"

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
let server: Server
let baseUrl: string

async function start(app: Express): Promise<void> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  baseUrl = `http://127.0.0.1:${address.port}`
}

interface Client {
  cookies: Map<string, string>
  csrf: string
}

function cookieHeader(client: Client): string {
  return [...client.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

async function call<T>(
  client: Client,
  path: string,
  init: RequestInit & { csrf?: boolean } = {},
): Promise<{ status: number; body: T; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const cookie = cookieHeader(client)
  if (cookie) headers.Cookie = cookie
  if (init.csrf !== false && client.csrf) headers["X-Manifest-CSRF"] = client.csrf
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...((init.headers as Record<string, string>) ?? {}) },
    redirect: "manual",
  })
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(";")
    const eq = pair?.indexOf("=") ?? -1
    if (pair && eq > 0) client.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const text = await response.text()
  let body: T
  try {
    body = JSON.parse(text) as T
  } catch {
    body = text as T
  }
  return { status: response.status, body, headers: response.headers }
}

interface ContextBody {
  result: {
    user: { id: string; email: string; name: string }
    csrfToken: string
    memberships: (Workspace & { role: string })[]
  }
}

async function devLogin(email: string, name = ""): Promise<Client> {
  const client: Client = { cookies: new Map(), csrf: "" }
  const res = await call<ContextBody>(client, "/api/v1/auth/dev", {
    method: "POST",
    body: JSON.stringify({ email, name }),
    csrf: false,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  client.csrf = res.body.result.csrfToken
  assert.ok(client.cookies.has("manifest_session"))
  return client
}

before(async () => {
  if (!TEST_DATABASE_URL) return
  pool = createPool(TEST_DATABASE_URL)
  await pool.query(
    "DROP TABLE IF EXISTS google_login_attempts, sessions, workspace_members, workspace_settings, users, workspaces, schema_migrations CASCADE",
  )
  const applied = await runMigrations(pool)
  assert.deepEqual(applied, ["0001_workspaces.sql", "0002_auth.sql"])
  const env = loadEnv({ NODE_ENV: "test", ALLOW_DEV_LOGIN: "true", SESSION_SECRET: SECRET })
  await start(createApp(env, { pool, googleProvider: fakeGoogle }))
})

after(async () => {
  if (!TEST_DATABASE_URL) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
  await pool.end()
})

test("unauthenticated requests are rejected with 401", { skip }, async () => {
  const anon: Client = { cookies: new Map(), csrf: "" }
  const context = await call<{ error: { code: string } }>(anon, "/api/v1/context")
  assert.equal(context.status, 401)
  assert.equal(context.body.error.code, "UNAUTHORIZED")

  const workspaces = await call(anon, "/api/v1/workspaces")
  assert.equal(workspaces.status, 401)
})

test("dev sign-in, CSRF, owner membership, and sign-out", { skip }, async () => {
  const ada = await devLogin("ada@example.com", "Ada")

  // Mutation without CSRF is rejected even with a valid session cookie.
  const noCsrf = await call<{ error: { code: string } }>(ada, "/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Acme", slug: "acme" }),
    csrf: false,
  })
  assert.equal(noCsrf.status, 403)
  assert.equal(noCsrf.body.error.code, "CSRF_REQUIRED")

  const created = await call<{ result: Workspace & { role: string } }>(ada, "/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: "Acme", slug: "acme" }),
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.result.role, "owner")

  const context = await call<ContextBody>(ada, "/api/v1/context")
  assert.equal(context.body.result.user.email, "ada@example.com")
  assert.equal(context.body.result.memberships[0]?.slug, "acme")

  const signOut = await call(ada, "/api/v1/session", { method: "DELETE" })
  assert.equal(signOut.status, 200)
  const afterOut = await call(ada, "/api/v1/context")
  assert.equal(afterOut.status, 401)
})

test("members can read but not write settings; non-members see 404", { skip }, async () => {
  const ada = await devLogin("ada@example.com")
  const context = await call<ContextBody>(ada, "/api/v1/context")
  const acme = context.body.result.memberships.find((m) => m.slug === "acme")
  assert.ok(acme)

  const ben = await devLogin("ben@example.com", "Ben")
  const benContext = await call<ContextBody>(ben, "/api/v1/context")
  const benId = benContext.body.result.user.id

  // Non-member: indistinguishable from a missing workspace.
  const hidden = await call(ben, `/api/v1/workspaces/${acme.id}/settings`)
  assert.equal(hidden.status, 404)

  await new WorkspacesRepository(pool).addMember(acme.id, benId, "member")

  const setByOwner = await call(ada, `/api/v1/workspaces/${acme.id}/settings/description`, {
    method: "PUT",
    body: JSON.stringify({ value: "Owner wrote this" }),
  })
  assert.equal(setByOwner.status, 200)

  const readByMember = await call<{ result: { value: unknown } }>(
    ben,
    `/api/v1/workspaces/${acme.id}/settings/description`,
  )
  assert.equal(readByMember.status, 200)
  assert.equal(readByMember.body.result.value, "Owner wrote this")

  const writeByMember = await call<{ error: { code: string } }>(
    ben,
    `/api/v1/workspaces/${acme.id}/settings/description`,
    { method: "PUT", body: JSON.stringify({ value: "Member overwrite" }) },
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
  const res = await call<{ error: { code: string } }>(eve, "/api/v1/context")
  assert.equal(res.status, 401)
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sessions
      WHERE user_id = (SELECT id FROM users WHERE email = 'eve@example.com')`,
  )
  assert.equal(rows[0]?.count, "0")
})

test("google sign-in round-trip with a fake provider; attempts are single-use", { skip }, async () => {
  const client: Client = { cookies: new Map(), csrf: "" }
  const startRes = await call(client, "/api/v1/auth/google?returnTo=/manifests")
  assert.equal(startRes.status, 302)
  const location = startRes.headers.get("location") ?? ""
  const state = new URL(location).searchParams.get("state")
  assert.ok(state)
  assert.ok(client.cookies.has("manifest_google_attempt"))

  const callback = `/api/v1/auth/google/callback?state=${state}&code=good-code`
  const done = await call(client, callback)
  assert.equal(done.status, 303)
  assert.equal(new URL(done.headers.get("location") ?? "").pathname, "/manifests")
  assert.ok(client.cookies.has("manifest_session"))

  const context = await call<ContextBody>(client, "/api/v1/context")
  assert.equal(context.body.result.user.email, "grace@example.com")

  // Replaying the same callback must not mint another session.
  const replay: Client = { cookies: new Map(), csrf: "" }
  replay.cookies.set(
    "manifest_google_attempt",
    client.cookies.get("manifest_google_attempt") ?? "",
  )
  const replayed = await call(replay, callback)
  assert.equal(replayed.status, 303)
  assert.match(replayed.headers.get("location") ?? "", /auth_error=google_account_rejected/)
})

test("auth config reports google and dev availability without secrets", { skip }, async () => {
  const anon: Client = { cookies: new Map(), csrf: "" }
  const res = await call<{ result: { google: boolean; devLogin: boolean } }>(
    anon,
    "/api/v1/auth/config",
  )
  assert.equal(res.body.result.google, true)
  assert.equal(res.body.result.devLogin, true)
  assert.ok(!JSON.stringify(res.body).includes(SECRET))
})
