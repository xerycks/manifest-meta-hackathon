import assert from "node:assert/strict"
import test from "node:test"

import {
  csrfTokenFor,
  newToken,
  openSealedText,
  safeEqual,
  safeReturnTo,
  sealText,
  tokenDigest,
} from "../../src/auth/tokens.js"

test("newToken produces 43-char base64url values that digest deterministically", () => {
  const token = newToken()
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(tokenDigest(token), tokenDigest(token))
  assert.notEqual(tokenDigest(token), tokenDigest(newToken()))
})

test("CSRF tokens are bound to both the secret and the session token", () => {
  const a = csrfTokenFor("secret-one", "session-a")
  assert.equal(a, csrfTokenFor("secret-one", "session-a"))
  assert.notEqual(a, csrfTokenFor("secret-two", "session-a"))
  assert.notEqual(a, csrfTokenFor("secret-one", "session-b"))
  assert.equal(safeEqual(a, a), true)
  assert.equal(safeEqual(a, "x"), false)
})

test("sealed values round-trip and fail closed under another secret", () => {
  const sealed = sealText("test-secret", "pkce-verifier-value")
  assert.equal(openSealedText("test-secret", sealed), "pkce-verifier-value")
  assert.throws(() => openSealedText("other-secret", sealed))
  assert.throws(() => openSealedText("test-secret", "not-sealed"))
})

test("safeReturnTo only allows same-origin app paths", () => {
  assert.equal(safeReturnTo("/manifests?tab=columns"), "/manifests?tab=columns")
  assert.equal(safeReturnTo("//evil.example/phish"), "/")
  assert.equal(safeReturnTo("https://evil.example/"), "/")
  assert.equal(safeReturnTo("/\\evil"), "/")
  assert.equal(safeReturnTo("/api/v1/workspaces"), "/")
  assert.equal(safeReturnTo("/ask?auth_error=google_cancelled"), "/ask")
  assert.equal(safeReturnTo(undefined), "/")
  assert.equal(safeReturnTo(""), "/")
})
