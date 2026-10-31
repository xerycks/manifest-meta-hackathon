import type { Connection, ConnectionEngine } from "./types.ts"

export const ENGINE_LABELS: Record<ConnectionEngine, string> = {
  postgres: "PostgreSQL",
  mongodb: "MongoDB",
}

/** What a source's parts are called, so screens read naturally for each engine. */
export interface EngineTerms {
  schema: string
  schemas: string
  object: string
  objects: string
  column: string
  columns: string
  row: string
  rows: string
}

export const ENGINE_TERMS: Record<ConnectionEngine, EngineTerms> = {
  postgres: {
    schema: "schema",
    schemas: "schemas",
    object: "table or view",
    objects: "tables and views",
    column: "column",
    columns: "columns",
    row: "row",
    rows: "rows",
  },
  mongodb: {
    schema: "database",
    schemas: "databases",
    object: "collection or view",
    objects: "collections and views",
    column: "field",
    columns: "fields",
    row: "document",
    rows: "documents",
  },
}

/** Where a source connects, without credentials, e.g. "reader@db.example.com:5432/shop". */
export function describeEndpoint(connection: Connection): string {
  if (connection.engine === "postgres") {
    const { username, host, port, database } = connection.config
    return `${username}@${host}:${port}/${database}`
  }
  const config = connection.config
  if (config.mode === "uri") {
    const scheme = config.srv ? "mongodb+srv" : "mongodb"
    return `${scheme}://${config.hosts.join(",")}${config.database ? `/${config.database}` : ""}`
  }
  return `${config.username ? `${config.username}@` : ""}${config.host}:${config.port}/${config.database}`
}
