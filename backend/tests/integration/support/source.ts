import { randomBytes } from "node:crypto"

import type { PostgresConfig } from "../../../src/connections/schemas.js"

/** Connection settings for the synthetic test source, taken from its URL. */
export function sourceSettings(url: string): { config: PostgresConfig; password: string } {
  const parsed = new URL(url)
  const sslMode = parsed.searchParams.get("sslmode")
  return {
    config: {
      host: parsed.hostname.replace(/^\[|\]$/g, ""),
      port: Number(parsed.port || 5432),
      database: decodeURIComponent(parsed.pathname.slice(1)),
      username: decodeURIComponent(parsed.username),
      sslMode: sslMode === "require" || sslMode === "verify-full" ? sslMode : "disable",
    },
    // Trust-auth test servers ignore the password, so a distinctive one still proves it never leaks.
    password: parsed.password
      ? decodeURIComponent(parsed.password)
      : `manifest-it-${randomBytes(12).toString("hex")}`,
  }
}
