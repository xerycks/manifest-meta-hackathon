import { BSON, type Document } from "mongodb"

import {
  MONGO_ALLOWED_STAGES,
  MONGO_FORBIDDEN_OPERATORS,
  MONGO_FORBIDDEN_STAGES,
} from "../connections/capabilities.js"
import { isSystemDatabase } from "../connections/schemas.js"
import type { MongoQuery, Rejection, RejectionReason } from "./schemas.js"

/** A MongoDB query that passed validation, with Extended JSON turned into BSON values. */
export type ValidatedMongoQuery = {
  language: "mongodb"
  database: string
  collection: string
} & (
  | {
      operation: "find"
      filter: Document
      projection: Document | null
      sort: Document | null
      skip: number | null
    }
  | { operation: "aggregate"; pipeline: Document[] }
)

/** Deeper nesting is refused before anything walks it. */
const MAX_DEPTH = 40

const ALLOWED_STAGES = new Set<string>(MONGO_ALLOWED_STAGES)
const FORBIDDEN_STAGES = new Set<string>(MONGO_FORBIDDEN_STAGES)
const FORBIDDEN_OPERATORS = new Set<string>(MONGO_FORBIDDEN_OPERATORS)

class Rejected extends Error {
  constructor(readonly rejection: Rejection) {
    super(rejection.message)
  }
}

function reject(reason: RejectionReason, message: string, name: string | null = null): never {
  throw new Rejected({ reason, message, name })
}

const isPlainObject = (value: unknown): value is Document => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return depth
  let deepest = depth
  for (const child of Object.values(value)) {
    deepest = Math.max(deepest, depthOf(child, depth + 1))
    if (deepest > MAX_DEPTH) break
  }
  return deepest
}

function checkCollectionName(name: string, label: string): void {
  if (name.startsWith("system.") || name.includes("$") || name.includes("\u0000")) {
    reject(
      "collection_not_allowed",
      `${label} "${name}" is not allowed: system collections and names with $ cannot be queried.`,
      name,
    )
  }
}

/** Extended JSON values ({"$date": …}, {"$oid": …}) become BSON values; numbers keep their type. */
function fromExtendedJson(value: unknown, label: string): unknown {
  try {
    return BSON.EJSON.deserialize(value as Document, { relaxed: false })
  } catch (error) {
    const detail = error instanceof Error ? error.message : "it is not valid Extended JSON"
    return reject("invalid_query", `The ${label} could not be read: ${detail}`)
  }
}

function documentOf(value: unknown, label: string): Document {
  const parsed = fromExtendedJson(value, label)
  if (!isPlainObject(parsed)) reject("invalid_query", `The ${label} must be a JSON object.`)
  return parsed
}

/** Refuses forbidden stages and operators at any depth: filters, expressions, and sub-pipelines. */
function scanForbidden(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) scanForbidden(item)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_OPERATORS.has(key)) {
      reject(
        "operator_not_allowed",
        `${key} runs JavaScript on the server, which queries may not do.`,
        key,
      )
    }
    if (FORBIDDEN_STAGES.has(key)) {
      reject(
        "stage_not_allowed",
        `${key} writes data or reads the server's state, so it is never allowed.`,
        key,
      )
    }
    scanForbidden(child)
  }
}

class PipelineChecker {
  constructor(private readonly database: string) {}

  check(pipeline: unknown, where: string): void {
    if (!Array.isArray(pipeline)) reject("invalid_query", `${where} must be an array of stages.`)
    for (const stage of pipeline) this.checkStage(stage, where)
  }

  private checkStage(stage: unknown, where: string): void {
    const keys = isPlainObject(stage) ? Object.keys(stage) : []
    const [name] = keys
    if (!isPlainObject(stage) || keys.length !== 1 || name === undefined) {
      reject("invalid_query", `Each stage in ${where} must be an object with exactly one stage name.`)
    }
    if (!ALLOWED_STAGES.has(name)) {
      reject(
        "stage_not_allowed",
        `${name} is not one of the stages queries may use (${[...ALLOWED_STAGES].join(", ")}).`,
        name,
      )
    }
    const spec = stage[name] as unknown
    switch (name) {
      case "$lookup":
        if (isPlainObject(spec)) {
          if (spec.from !== undefined) this.sameDatabase(spec.from, "$lookup")
          if (spec.pipeline !== undefined) this.check(spec.pipeline, "the $lookup pipeline")
        }
        break
      case "$graphLookup":
        if (isPlainObject(spec)) this.sameDatabase(spec.from, "$graphLookup")
        break
      case "$unionWith":
        if (isPlainObject(spec)) {
          if (spec.db !== undefined) {
            this.otherDatabase("$unionWith", `${String(spec.db)}.${String(spec.coll)}`)
          }
          this.sameDatabase(spec.coll, "$unionWith")
          if (spec.pipeline !== undefined) this.check(spec.pipeline, "the $unionWith pipeline")
        } else {
          this.sameDatabase(spec, "$unionWith")
        }
        break
      case "$facet":
        if (isPlainObject(spec)) {
          for (const [output, pipeline] of Object.entries(spec)) {
            this.check(pipeline, `the $facet pipeline "${output}"`)
          }
        }
        break
    }
  }

  /** Joins name a collection or view of the query's own database, never {db, coll}. */
  private sameDatabase(from: unknown, stage: string): void {
    if (isPlainObject(from)) {
      this.otherDatabase(stage, `${String(from.db)}.${String(from.coll)}`)
    }
    if (typeof from !== "string" || from.length === 0) {
      reject("invalid_query", `${stage} must name a collection of the database ${this.database}.`)
    }
    checkCollectionName(from, `${stage} collection`)
  }

  private otherDatabase(stage: string, name: string): never {
    return reject(
      "cross_database",
      `${stage} can only read collections of the same database (${this.database}); "${name}" names another database.`,
      name,
    )
  }
}

/**
 * Checks a MongoDB read against the source's selected databases and the
 * stage and operator lists in capabilities.ts.
 */
export function validateMongoQuery(
  query: MongoQuery,
  databases: string[],
): { query: ValidatedMongoQuery } | { rejection: Rejection } {
  try {
    if (!databases.includes(query.database) || isSystemDatabase(query.database)) {
      reject(
        "database_not_allowed",
        `"${query.database}" is not one of the databases this source may read (${databases.join(", ") || "none"}).`,
        query.database,
      )
    }
    checkCollectionName(query.collection, "The collection")
    if (depthOf(query) > MAX_DEPTH) {
      reject("invalid_query", `The query is nested more than ${MAX_DEPTH} levels deep.`)
    }
    const base = { language: "mongodb", database: query.database, collection: query.collection } as const

    if (query.operation === "find") {
      const parts = {
        filter: documentOf(query.filter ?? {}, "filter"),
        projection: query.projection ? documentOf(query.projection, "projection") : null,
        sort: query.sort ? documentOf(query.sort, "sort") : null,
      }
      scanForbidden(Object.values(parts))
      return { query: { ...base, operation: "find", ...parts, skip: query.skip ?? null } }
    }

    const pipeline = fromExtendedJson(query.pipeline ?? [], "pipeline")
    scanForbidden(pipeline)
    new PipelineChecker(query.database).check(pipeline, "the pipeline")
    return { query: { ...base, operation: "aggregate", pipeline: pipeline as Document[] } }
  } catch (error) {
    if (error instanceof Rejected) return { rejection: error.rejection }
    throw error
  }
}
