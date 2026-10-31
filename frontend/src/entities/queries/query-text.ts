import type { ReadQuery } from "./types.ts"

/** A query as people read and copy it: SQL as written, MongoDB as indented JSON. */
export function queryText(query: ReadQuery): string {
  if (query.language === "sql") return query.sql
  const { language: _language, ...rest } = query
  return JSON.stringify(rest, null, 2)
}

/** "SQL" or "MongoDB find" / "MongoDB aggregate". */
export function queryKind(query: ReadQuery): string {
  return query.language === "sql" ? "SQL" : `MongoDB ${query.operation}`
}
