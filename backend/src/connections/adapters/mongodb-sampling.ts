import type { Document } from "mongodb"

import type { DiscoveredColumn, TypeCount } from "./types.js"

/** Bounds on what one collection's sample may add, so odd documents cannot blow up a refresh. */
export const FIELD_LIMITS = {
  /** Path segments at most, so `a.b.c` uses three. */
  depth: 6,
  fields: 500,
  /** Elements read from each array value. */
  arrayElements: 50,
  pathChars: 300,
} as const

/** BSON classes (read with promoteValues: false) to MongoDB's $type names. */
const BSON_TYPES: Record<string, string> = {
  Int32: "int",
  Double: "double",
  Long: "long",
  Decimal128: "decimal",
  ObjectId: "objectId",
  Binary: "binData",
  Timestamp: "timestamp",
  BSONRegExp: "regex",
  Code: "javascript",
  MinKey: "minKey",
  MaxKey: "maxKey",
  BSONSymbol: "symbol",
  DBRef: "dbRef",
}

/** The BSON type of a value as the driver returns it with promoteValues: false. */
export function bsonTypeOf(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return "string"
  if (typeof value === "boolean") return "bool"
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double"
  if (typeof value === "bigint") return "long"
  if (value instanceof Date) return "date"
  if (value instanceof RegExp) return "regex"
  if (Array.isArray(value)) return "array"
  if (typeof value === "object") {
    const bsonType = (value as { _bsontype?: unknown })._bsontype
    if (typeof bsonType === "string") return BSON_TYPES[bsonType] ?? bsonType
    return "object"
  }
  return typeof value
}

interface FieldNode {
  path: string
  depth: number
  children: Map<string, FieldNode>
  /** Documents in which the field held each type. */
  types: Map<string, number>
  elementTypes: Map<string, number>
  /** Documents in which the field was present. */
  documents: number
}

/** Types seen in one document, per field; a document counts once per type. */
type Seen = Map<FieldNode, Set<string>>

const byFrequency = (counts: Map<string, number>): TypeCount[] =>
  [...counts]
    .map(([type, documents]) => ({ type, documents }))
    .sort((a, b) => b.documents - a.documents || a.type.localeCompare(b.type))

/**
 * Every type seen, most common first, joined with " | " (e.g. "int | string |
 * null"); arrays name their element types, e.g. "array<object>".
 */
export function formatFieldType(types: TypeCount[], elementTypes: TypeCount[]): string {
  const elements = elementTypes.map((entry) => entry.type).join(" | ")
  return types
    .map(({ type }) => (type === "array" && elements ? `array<${elements}>` : type))
    .join(" | ")
}

function addSeen(seen: Seen, node: FieldNode, type: string): void {
  const types = seen.get(node)
  if (types) types.add(type)
  else seen.set(node, new Set([type]))
}

/**
 * Infers fields as dotted paths from sampled documents, one document at a
 * time so the sample itself is never held in memory. Nested documents and
 * arrays of documents add child paths (`items.sku`), as MongoDB queries see
 * them. Only types and counts are kept, never values.
 */
export class FieldProfiler {
  private readonly root = new Map<string, FieldNode>()
  private fieldCount = 0
  sampled = 0
  fieldsTruncated = false
  depthTruncated = false

  add(document: Document): void {
    this.sampled += 1
    const seen: Seen = new Map()
    const elements: Seen = new Map()
    this.walk(document, this.root, "", 0, seen, elements)
    for (const [node, types] of seen) {
      node.documents += 1
      for (const type of types) node.types.set(type, (node.types.get(type) ?? 0) + 1)
    }
    for (const [node, types] of elements) {
      for (const type of types) node.elementTypes.set(type, (node.elementTypes.get(type) ?? 0) + 1)
    }
  }

  /** Fields in document order: each parent directly followed by its children. */
  fields(): DiscoveredColumn[] {
    const columns: DiscoveredColumn[] = []
    const names = new Set<string>()
    const visit = (nodes: Map<string, FieldNode>) => {
      for (const node of nodes.values()) {
        // A key containing a dot can spell the same path as a nested field; keep the first.
        if (!names.has(node.path)) {
          names.add(node.path)
          columns.push(this.column(node, columns.length + 1))
        }
        visit(node.children)
      }
    }
    visit(this.root)
    return columns
  }

  private column(node: FieldNode, ordinal: number): DiscoveredColumn {
    const types = byFrequency(node.types)
    const elementTypes = byFrequency(node.elementTypes)
    const missing = this.sampled - node.documents
    return {
      name: node.path,
      ordinal,
      dataType: formatFieldType(types, elementTypes),
      nullable: missing > 0 || node.types.has("null"),
      defaultValue: null,
      isPrimaryKey: node.path === "_id",
      enumValues: null,
      comment: null,
      details: {
        engine: "mongodb",
        sampleSize: this.sampled,
        types,
        missing,
        arrayElementTypes: node.types.has("array") ? elementTypes : null,
        depth: node.depth,
      },
    }
  }

  private walk(
    document: object,
    children: Map<string, FieldNode>,
    prefix: string,
    depth: number,
    seen: Seen,
    elements: Seen,
  ): void {
    for (const [key, value] of Object.entries(document)) {
      const node = this.node(children, key, prefix, depth)
      if (node) this.observe(node, value, seen, elements)
    }
  }

  private observe(node: FieldNode, value: unknown, seen: Seen, elements: Seen): void {
    const type = bsonTypeOf(value)
    addSeen(seen, node, type)
    if (type === "object") {
      this.walk(value as object, node.children, node.path, node.depth + 1, seen, elements)
    } else if (type === "array") {
      for (const element of (value as unknown[]).slice(0, FIELD_LIMITS.arrayElements)) {
        const elementType = bsonTypeOf(element)
        addSeen(elements, node, elementType)
        if (elementType === "object") {
          this.walk(element as object, node.children, node.path, node.depth + 1, seen, elements)
        }
      }
    }
  }

  private node(
    children: Map<string, FieldNode>,
    key: string,
    prefix: string,
    depth: number,
  ): FieldNode | null {
    const existing = children.get(key)
    if (existing) return existing
    if (depth >= FIELD_LIMITS.depth) {
      this.depthTruncated = true
      return null
    }
    const path = prefix ? `${prefix}.${key}` : key
    if (this.fieldCount >= FIELD_LIMITS.fields || path.length > FIELD_LIMITS.pathChars) {
      this.fieldsTruncated = true
      return null
    }
    this.fieldCount += 1
    const node: FieldNode = {
      path,
      depth,
      children: new Map(),
      types: new Map(),
      elementTypes: new Map(),
      documents: 0,
    }
    children.set(key, node)
    return node
  }
}
