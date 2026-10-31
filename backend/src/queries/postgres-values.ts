import type { FieldDef } from "pg"

import type { Cell, ColumnKind, ResultColumn } from "./schemas.js"

// Rows are read as PostgreSQL's text output and encoded here, so int8 and
// numeric keep every digit and timestamps keep their microseconds.

type Encoding = "number" | "float" | "boolean" | "timestamp" | "text"

const BUILT_IN_TYPES: Record<number, { kind: ColumnKind; encoding: Encoding }> = {
  16: { kind: "boolean", encoding: "boolean" },
  17: { kind: "binary", encoding: "text" },
  18: { kind: "text", encoding: "text" },
  19: { kind: "text", encoding: "text" },
  20: { kind: "integer", encoding: "text" },
  21: { kind: "integer", encoding: "number" },
  23: { kind: "integer", encoding: "number" },
  25: { kind: "text", encoding: "text" },
  26: { kind: "integer", encoding: "number" },
  114: { kind: "json", encoding: "text" },
  700: { kind: "float", encoding: "float" },
  701: { kind: "float", encoding: "float" },
  1042: { kind: "text", encoding: "text" },
  1043: { kind: "text", encoding: "text" },
  1082: { kind: "date", encoding: "text" },
  1083: { kind: "time", encoding: "text" },
  1114: { kind: "datetime", encoding: "timestamp" },
  1184: { kind: "datetime", encoding: "timestamp" },
  1266: { kind: "time", encoding: "text" },
  1700: { kind: "decimal", encoding: "text" },
  2950: { kind: "id", encoding: "text" },
  3802: { kind: "json", encoding: "text" },
}

/** What pg_type says about a result column's type. */
export interface PostgresTypeInfo {
  oid: number
  /** format_type() output, e.g. "numeric" or "timestamp with time zone". */
  name: string
  /** pg_type.typcategory, e.g. "N" for numeric types. */
  category: string
  /** For a domain, the type it is based on. */
  base: number | null
}

/** A result column and how its text values become cells. */
export interface PostgresColumn {
  column: ResultColumn
  encode(text: string | null): Cell
}

const TIMESTAMP = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::\d{2}){0,2})?$/

/**
 * PostgreSQL's ISO output ("2026-10-31 09:30:00.123456+00") as ISO 8601
 * ("2026-10-31T09:30:00.123456Z"). Values it cannot express, such as
 * "infinity" or BC dates, are returned unchanged.
 */
export function isoTimestamp(text: string): string {
  const match = TIMESTAMP.exec(text)
  if (!match) return text
  const [, date, time, offset] = match
  if (!offset) return `${date}T${time}`
  if (offset === "+00") return `${date}T${time}Z`
  return `${date}T${time}${offset.length === 3 ? `${offset}:00` : offset}`
}

function encoder(encoding: Encoding): (text: string) => Cell {
  switch (encoding) {
    case "number":
      return Number
    case "float":
      // NaN and infinities have no JSON number, so they stay as PostgreSQL wrote them.
      return (text) => (Number.isFinite(Number(text)) ? Number(text) : text)
    case "boolean":
      return (text) => text === "t"
    case "timestamp":
      return isoTimestamp
    case "text":
      return (text) => text
  }
}

/** Columns in result order; duplicate names stay as they are. */
export function postgresColumns(
  fields: FieldDef[],
  types: Map<number, PostgresTypeInfo>,
): PostgresColumn[] {
  return fields.map((field) => {
    const info = types.get(field.dataTypeID)
    const builtIn =
      BUILT_IN_TYPES[field.dataTypeID] ?? (info?.base ? BUILT_IN_TYPES[info.base] : undefined)
    const { kind, encoding } =
      builtIn ??
      (info?.category === "N"
        ? { kind: "decimal" as const, encoding: "text" as const }
        : { kind: "text" as const, encoding: "text" as const })
    const encode = encoder(encoding)
    return {
      column: { name: field.name, type: info?.name ?? "unknown", kind },
      encode: (text) => (text === null ? null : encode(text)),
    }
  })
}
