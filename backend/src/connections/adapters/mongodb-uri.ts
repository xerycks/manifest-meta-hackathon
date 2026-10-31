import { MongoClient } from "mongodb"

import type { MongoUriSummary } from "../schemas.js"

/** A connection string Manifest will not use. The message is safe to show: it never echoes the string. */
export class UnusableConnectionString extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnusableConnectionString"
  }
}

/** Password-based sign-in only: other mechanisms would use this server's own cloud or Kerberos identity. */
const ALLOWED_MECHANISMS = new Set(["DEFAULT", "SCRAM-SHA-1", "SCRAM-SHA-256", "PLAIN"])

/** Options that make the driver read files on the Manifest server or send traffic through a proxy. */
const SERVER_SIDE_OPTIONS = [
  "tlsCAFile",
  "tlsCertificateKeyFile",
  "tlsCRLFile",
  "proxyHost",
] as const

const DATABASE_NAME = /^[^/\\. "$*<>:|?]{1,63}$/

/** The database named in the path, read without touching the credentials before it. */
function pathDatabase(uri: string): string | null {
  const rest = uri.slice(uri.indexOf("://") + 3)
  const slash = rest.search(/[/?#]/)
  if (slash === -1 || rest[slash] !== "/") return null
  const path = rest.slice(slash + 1).split(/[?#]/)[0] ?? ""
  if (!path) return null
  let database: string
  try {
    database = decodeURIComponent(path)
  } catch {
    database = ""
  }
  if (!DATABASE_NAME.test(database)) {
    throw new UnusableConnectionString("The database in the connection string's path is not a valid database name.")
  }
  return database
}

/**
 * Checks a MongoDB connection string with the driver's own parser and returns
 * what may be stored and shown: hosts and database, never credentials.
 */
export function inspectMongoUri(uri: string): MongoUriSummary {
  let options: MongoClient["options"]
  try {
    // Parsing only: a client connects on first use, and SRV records are resolved then.
    options = new MongoClient(uri).options
  } catch {
    throw new UnusableConnectionString(
      "MongoDB cannot use this connection string. Check its format, hosts, and options.",
    )
  }
  const mechanism = options.credentials?.mechanism
  if (mechanism && !ALLOWED_MECHANISMS.has(mechanism)) {
    throw new UnusableConnectionString(
      "Sign in with a username and password (SCRAM or PLAIN). Other authentication mechanisms are not supported.",
    )
  }
  if (SERVER_SIDE_OPTIONS.some((option) => options[option] !== undefined)) {
    throw new UnusableConnectionString(
      "Remove the tlsCAFile, tlsCertificateKeyFile, tlsCRLFile, and proxyHost options: Manifest does not read files or use proxies for sources.",
    )
  }
  const srv = uri.startsWith("mongodb+srv://")
  const hosts = srv && options.srvHost ? [options.srvHost] : options.hosts.map(String)
  return { mode: "uri", hosts, srv, database: pathDatabase(uri) }
}
