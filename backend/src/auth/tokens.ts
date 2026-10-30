import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"

/** 32 random bytes as base64url (43 chars) — used for session/state tokens. */
export function newToken(): string {
  return randomBytes(32).toString("base64url")
}

/** Sessions and attempts are stored by digest so a DB leak exposes no live tokens. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** CSRF token bound to one session; compared in constant time at the edge. */
export function csrfTokenFor(secret: string, sessionToken: string): string {
  return createHmac("sha256", secret).update(`manifest-csrf:${sessionToken}`).digest("hex")
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sealKey(secret: string): Buffer {
  return createHash("sha256").update(`manifest-seal:${secret}`).digest()
}

/** AES-256-GCM seal for short-lived secrets kept at rest (PKCE verifiers). */
export function sealText(secret: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", sealKey(secret), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
}

export function openSealedText(secret: string, sealed: string): string {
  const [ivPart, tagPart, dataPart] = sealed.split(".")
  if (!ivPart || !tagPart || !dataPart) throw new Error("Malformed sealed value")
  const decipher = createDecipheriv("aes-256-gcm", sealKey(secret), Buffer.from(ivPart, "base64url"))
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"))
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8")
}

/** Only same-origin relative paths may be used as post-login destinations. */
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    return "/"
  }
  try {
    const url = new URL(value, "https://manifest.invalid")
    if (url.origin !== "https://manifest.invalid") return "/"
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return "/"
    url.searchParams.delete("auth_error")
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return "/"
  }
}
