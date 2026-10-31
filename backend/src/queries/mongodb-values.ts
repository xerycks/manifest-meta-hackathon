import type { Binary, Document } from "mongodb"

import { bsonTypeOf } from "../connections/adapters/mongodb-sampling.js"
import type { ResultCollector } from "./results.js"
import { MISSING, type Cell, type ColumnKind, type ResultColumn } from "./schemas.js"

// Documents are read with promoteValues: false, so Int32, Long, Double, and
// Decimal128 arrive as BSON classes and are encoded here without a float in between.

const KINDS: Record<string, ColumnKind> = {
  objectId: "id",
  uuid: "id",
  string: "text",
  int: "integer",
  long: "integer",
  double: "float",
  decimal: "decimal",
  bool: "boolean",
  date: "datetime",
  object: "json",
  array: "json",
  dbRef: "json",
  binData: "binary",
  timestamp: "text",
  regex: "text",
  javascript: "text",
  symbol: "text",
  minKey: "text",
  maxKey: "text",
}

const UUID_SUBTYPE = 4
/** A padded {"$missing": true} cell and its comma. */
const MISSING_BYTES = JSON.stringify(MISSING).length + 1

interface BsonValue {
  _bsontype: string
  value?: unknown
  toString(encoding?: string): string
}

const bsonClass = (value: unknown): string | null =>
  typeof value === "object" && value !== null && typeof (value as BsonValue)._bsontype === "string"
    ? (value as BsonValue)._bsontype
    : null

function isUuid(value: unknown): value is Binary {
  return bsonClass(value) === "Binary" && (value as Binary).sub_type === UUID_SUBTYPE
}

/** MongoDB's $type name, except that UUID binaries are told apart as "uuid". */
function typeOf(value: unknown): string {
  return isUuid(value) ? "uuid" : bsonTypeOf(value)
}

function uuidText(binary: Binary): string {
  try {
    return binary.toUUID().toHexString(true)
  } catch {
    return `\\x${binary.toString("hex")}`
  }
}

const finiteOr = <T>(number: number, fallback: (text: string) => T) =>
  Number.isFinite(number) ? number : fallback(String(number))

const isoDate = (date: Date) => (Number.isNaN(date.getTime()) ? null : date.toISOString())

/** Nested values as relaxed Extended JSON, except that Long and Decimal128 keep every digit. */
function extendedJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return finiteOr(value, (text) => ({ $numberDouble: text }))
  if (typeof value === "bigint") return { $numberLong: value.toString() }
  if (typeof value !== "object") return value
  if (value instanceof Date) return { $date: isoDate(value) }
  if (Array.isArray(value)) return value.map(extendedJson)
  const bson = value as BsonValue & Record<string, unknown>
  switch (bsonClass(value)) {
    case "Int32":
      return bson.value
    case "Double":
      return finiteOr(Number(bson.value), (text) => ({ $numberDouble: text }))
    case "Long":
      return { $numberLong: bson.toString() }
    case "Decimal128":
      return { $numberDecimal: bson.toString() }
    case "ObjectId":
      return { $oid: bson.toString() }
    case "Binary":
      return isUuid(value)
        ? { $uuid: uuidText(value) }
        : {
            $binary: {
              base64: bson.toString("base64"),
              subType: (value as unknown as Binary).sub_type.toString(16).padStart(2, "0"),
            },
          }
    case "Timestamp":
      return { $timestamp: { t: bson.t, i: bson.i } }
    case "BSONRegExp":
      return { $regularExpression: { pattern: bson.pattern, options: bson.options } }
    case "Code":
      return { $code: bson.code }
    case "MinKey":
      return { $minKey: 1 }
    case "MaxKey":
      return { $maxKey: 1 }
    case "BSONSymbol":
      return { $symbol: String(bson.value) }
    case "DBRef":
      return {
        $ref: bson.collection,
        $id: extendedJson(bson.oid),
        ...(bson.db ? { $db: bson.db } : {}),
      }
    default:
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, extendedJson(child)]))
  }
}

/** A top-level field value as a result cell (see the result format in schemas.ts). */
export function mongoCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return finiteOr(value, (text) => text)
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return isoDate(value) ?? "Invalid Date"
  const bson = value as BsonValue & Record<string, unknown>
  switch (bsonClass(value)) {
    case "Int32":
      return Number(bson.value)
    case "Double":
      return finiteOr(Number(bson.value), (text) => text)
    case "Long":
    case "Decimal128":
    case "ObjectId":
      return bson.toString()
    case "Binary":
      return isUuid(value) ? uuidText(value) : `\\x${bson.toString("hex")}`
    case "Timestamp":
      return `Timestamp(${String(bson.t)}, ${String(bson.i)})`
    case "BSONRegExp":
      return `/${String(bson.pattern)}/${String(bson.options)}`
    case "Code":
      return String(bson.code)
    case "MinKey":
      return "MinKey"
    case "MaxKey":
      return "MaxKey"
    case "BSONSymbol":
      return String(bson.value)
    default:
      // Documents, arrays, and DBRefs.
      return JSON.stringify(extendedJson(value))
  }
}

function columnFor(name: string, types: string[]): ResultColumn {
  const present = types.filter((type) => type !== "null")
  const kinds = new Set(present.map((type) => KINDS[type] ?? "unknown"))
  const [kind] = kinds
  return {
    name,
    type: present.length > 0 ? present.join(" | ") : "null",
    kind: kinds.size === 1 && kind ? kind : "unknown",
  }
}

/**
 * Turns documents into rows. Columns are the top-level fields in order of
 * first appearance; a document without a field gets {"$missing": true} there.
 */
export class MongoRows {
  /** Field name to the types seen in it, in column order. */
  private readonly fields = new Map<string, string[]>()

  constructor(private readonly collector: ResultCollector) {}

  /** Adds a document, or returns false once the collector is full. */
  add(document: Document): boolean {
    const entries = Object.entries(document)
    const added = entries.map(([key]) => key).filter((key) => !this.fields.has(key))
    const names = [...this.fields.keys(), ...added]
    const row: Cell[] = names.map(() => MISSING)
    const values = new Map(entries)
    names.forEach((name, index) => {
      if (values.has(name)) row[index] = mongoCell(values.get(name))
    })
    // Rows already kept get a missing cell for each new field, which counts toward the byte limit.
    const padding = added.length * this.collector.rows.length * MISSING_BYTES
    if (!this.collector.add(row, padding)) return false

    for (const [key, value] of entries) {
      const types = this.fields.get(key) ?? []
      const type = typeOf(value)
      if (!types.includes(type)) types.push(type)
      this.fields.set(key, types)
    }
    return true
  }

  /** Columns for every field seen; rows read before a field first appeared are padded. */
  columns(): ResultColumn[] {
    const width = this.fields.size
    for (const row of this.collector.rows) {
      while (row.length < width) row.push(MISSING)
    }
    return [...this.fields].map(([name, types]) => columnFor(name, types))
  }
}
