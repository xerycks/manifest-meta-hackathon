import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import test from "node:test"

import { CredentialSealer, CredentialsUnreadable } from "../../src/connections/credentials.js"

const KEY = randomBytes(32).toString("hex")
const BINDING = {
  workspaceId: "6f1c1b7e-8a51-4f7e-9d43-0d6f3a1e2b10",
  connectionId: "0b8f3c2a-7d1e-4f65-a0c9-5e2d4b6a8c01",
}
const PASSWORD = "correct horse battery staple"

test("sealed secrets round-trip and never contain the plaintext", () => {
  const sealer = new CredentialSealer(KEY)
  const sealed = sealer.seal({ password: PASSWORD }, BINDING)
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  assert.ok(!sealed.includes(PASSWORD))
  assert.deepEqual(sealer.open(sealed, BINDING), { password: PASSWORD })
  // A fresh IV per seal: the same secret never produces the same envelope.
  assert.notEqual(sealer.seal({ password: PASSWORD }, BINDING), sealed)
})

test("tampered envelopes fail closed", () => {
  const sealer = new CredentialSealer(KEY)
  const sealed = sealer.seal({ password: PASSWORD }, BINDING)
  const [version, iv, tag, data] = sealed.split(".") as [string, string, string, string]
  const flipped = Buffer.from(data, "base64url")
  flipped[0] = (flipped[0] ?? 0) ^ 0x01
  const tampered = [version, iv, tag, flipped.toString("base64url")].join(".")

  assert.throws(() => sealer.open(tampered, BINDING), CredentialsUnreadable)
  assert.throws(() => sealer.open(`v2.${iv}.${tag}.${data}`, BINDING), CredentialsUnreadable)
  assert.throws(() => sealer.open("not-an-envelope", BINDING), CredentialsUnreadable)
  assert.throws(() => sealer.open(`${sealed}.extra`, BINDING), CredentialsUnreadable)
})

test("ciphertext is bound to its workspace and connection", () => {
  const sealer = new CredentialSealer(KEY)
  const sealed = sealer.seal({ password: PASSWORD }, BINDING)
  assert.throws(
    () => sealer.open(sealed, { ...BINDING, connectionId: "9a0e7c1d-2b3f-4a5e-8c6d-7f8091a2b3c4" }),
    CredentialsUnreadable,
  )
  assert.throws(
    () => sealer.open(sealed, { ...BINDING, workspaceId: "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }),
    CredentialsUnreadable,
  )
})

test("another key cannot open the envelope, and keys must be 32 bytes", () => {
  const sealed = new CredentialSealer(KEY).seal({ password: PASSWORD }, BINDING)
  const other = new CredentialSealer(randomBytes(32).toString("hex"))
  assert.throws(() => other.open(sealed, BINDING), CredentialsUnreadable)
  assert.throws(() => new CredentialSealer("abcd"), /32 bytes/)
})

test("a secret without a password round-trips as an empty secret", () => {
  const sealer = new CredentialSealer(KEY)
  assert.deepEqual(sealer.open(sealer.seal({}, BINDING), BINDING), {})
})
