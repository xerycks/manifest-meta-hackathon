import assert from "node:assert/strict"
import test from "node:test"

import { managesWorkspace } from "../src/app/organization-role.ts"
import { authErrorMessage } from "../src/shared/api/auth-errors.ts"
import { apiRequest, setCsrfToken } from "../src/shared/api/client.ts"

test("authErrorMessage maps known codes and falls back safely", () => {
  assert.match(authErrorMessage("google_cancelled"), /cancelled/)
  assert.match(authErrorMessage("google_account_rejected"), /verified Google/)
  assert.equal(authErrorMessage("something_else"), "Sign-in failed. Please try again.")
  assert.equal(authErrorMessage(null), "")
  assert.equal(authErrorMessage(undefined), "")
})

test("managesWorkspace allows owners and admins only", () => {
  assert.equal(managesWorkspace("owner"), true)
  assert.equal(managesWorkspace("admin"), true)
  assert.equal(managesWorkspace("member"), false)
  assert.equal(managesWorkspace(null), false)
})

test("apiRequest attaches the CSRF header to mutations only", async () => {
  const seen: (Record<string, string> | undefined)[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push(init?.headers as Record<string, string>)
    return new Response(JSON.stringify({ success: true, result: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  try {
    setCsrfToken("csrf-123")
    await apiRequest("/api/v1/context")
    await apiRequest("/api/v1/workspaces", { method: "POST", body: {} })
    assert.equal(seen[0]?.["X-Manifest-CSRF"], undefined)
    assert.equal(seen[1]?.["X-Manifest-CSRF"], "csrf-123")
  } finally {
    setCsrfToken(null)
    globalThis.fetch = originalFetch
  }
})
