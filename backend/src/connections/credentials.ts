import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { z } from "zod"

import type { SourceSecret } from "./adapters/types.js"

const VERSION = "v1"
const IV_BYTES = 12
const TAG_BYTES = 16

/** Ciphertext is bound to one row: it cannot be swapped between connections or workspaces. */
export interface SealBinding {
  workspaceId: string
  connectionId: string
}

const secretSchema = z.strictObject({ password: z.string().optional(), uri: z.string().optional() })

export class CredentialsUnreadable extends Error {
  constructor() {
    super("Sealed credentials could not be opened")
    this.name = "CredentialsUnreadable"
  }
}

function additionalData(binding: SealBinding): Buffer {
  return Buffer.from(`manifest:connection:${VERSION}:${binding.workspaceId}:${binding.connectionId}`)
}

/**
 * AES-256-GCM envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url). The version
 * prefix leaves room for key rotation without guessing at stored formats.
 */
export class CredentialSealer {
  private readonly key: Buffer

  constructor(keyHex: string) {
    this.key = Buffer.from(keyHex, "hex")
    if (this.key.length !== 32) throw new Error("The connection encryption key must be 32 bytes")
  }

  seal(secret: SourceSecret, binding: SealBinding): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", this.key, iv)
    cipher.setAAD(additionalData(binding))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()])
    return [VERSION, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".")
  }

  open(sealed: string, binding: SealBinding): SourceSecret {
    const [version, ivPart, tagPart, dataPart, ...rest] = sealed.split(".")
    if (version !== VERSION || !ivPart || !tagPart || !dataPart || rest.length > 0) {
      throw new CredentialsUnreadable()
    }
    try {
      const iv = Buffer.from(ivPart, "base64url")
      const tag = Buffer.from(tagPart, "base64url")
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CredentialsUnreadable()
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv, { authTagLength: TAG_BYTES })
      decipher.setAAD(additionalData(binding))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(dataPart, "base64url")),
        decipher.final(),
      ]).toString("utf8")
      const parsed = secretSchema.parse(JSON.parse(plaintext))
      return {
        ...(parsed.password !== undefined ? { password: parsed.password } : {}),
        ...(parsed.uri !== undefined ? { uri: parsed.uri } : {}),
      }
    } catch {
      throw new CredentialsUnreadable()
    }
  }
}
