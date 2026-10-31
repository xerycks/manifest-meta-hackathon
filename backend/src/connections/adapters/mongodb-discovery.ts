import { randomUUID } from "node:crypto"

import { BSON, type Collection, type Db, type Document, type MongoClient } from "mongodb"

import { FieldProfiler } from "./mongodb-sampling.js"
import {
  DISCOVERY_LIMITS,
  DiscoveryLimitExceeded,
  type DiscoveredMetadata,
  type DiscoveredObject,
  type DiscoveryRequest,
  type MongoCollectionDetails,
} from "./types.js"

/** Documents sampled per collection. */
export const SAMPLE_SIZE = 200
/** Server-side limit for each listing, count, and sample. */
export const OPERATION_MAX_TIME_MS = 10_000
/** Sampling stops once this much BSON has been read from one collection. */
const SAMPLE_BYTES = 16 * 1024 * 1024
const MAX_COMMENT_CHARS = 4_000
const MAX_VIEW_DEFINITION_CHARS = 20_000
/** At most one progress write per interval, plus the last. */
const PROGRESS_INTERVAL_MS = 250

const UNAUTHORIZED = 13
const MAX_TIME_EXPIRED = 50
const INTERRUPTED_CODES = new Set([11600, 11601, 11602, 262])

const READ_OPTIONS = {
  maxTimeMS: OPERATION_MAX_TIME_MS,
  batchSize: 50,
  // Keeps int, long, double, and decimal apart instead of turning them all into numbers.
  promoteValues: false,
  promoteLongs: false,
  bsonRegExp: true,
} as const

/** Every server operation of one discovery carries its abort signal and a comment naming the run. */
interface RunTag {
  signal: AbortSignal
  comment: string
}

interface ListedCollection {
  database: string
  name: string
  type: "collection" | "timeseries" | "view"
  options: Document | null
}

/** A command the server refused or failed (as opposed to a lost connection or an abort). */
function serverErrorCode(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== "MongoServerError") return null
  // Replies read with promoteValues: false (sampling) carry the code as an Int32, not a number.
  const code = Number((error as { code?: unknown }).code)
  return Number.isInteger(code) ? code : null
}

const count = (value: number) => value.toLocaleString("en-US")

async function listCollections(db: Db, run: RunTag): Promise<ListedCollection[]> {
  const read = async (nameOnly: boolean) => {
    const listed: ListedCollection[] = []
    const cursor = db.listCollections(
      {},
      { nameOnly, authorizedCollections: true, maxTimeMS: OPERATION_MAX_TIME_MS, ...run },
    )
    try {
      for await (const info of cursor) {
        const type = info.type
        // system.* holds MongoDB's own data, including the buckets behind time series collections.
        if (info.name.startsWith("system.")) continue
        if (type !== "collection" && type !== "timeseries" && type !== "view") continue
        listed.push({
          database: db.databaseName,
          name: info.name,
          type,
          options: "options" in info && info.options ? info.options : null,
        })
        if (listed.length > DISCOVERY_LIMITS.objects) break
      }
    } finally {
      await cursor.close().catch(() => {})
    }
    return listed
  }
  try {
    return await read(false)
  } catch (error) {
    // Users without listCollections may still list the collections they can read, by name.
    if (serverErrorCode(error) !== UNAUTHORIZED) throw error
    return read(true)
  }
}

interface Sample {
  profiler: FieldProfiler
  method: MongoCollectionDetails["sampleMethod"]
  bytesLimited: boolean
}

async function readSample(
  cursor: AsyncIterable<Document> & { close(): Promise<void> },
  method: Sample["method"],
): Promise<Sample> {
  const profiler = new FieldProfiler()
  let bytes = 0
  let bytesLimited = false
  try {
    for await (const document of cursor) {
      profiler.add(document)
      bytes += BSON.calculateObjectSize(document)
      if (profiler.sampled >= SAMPLE_SIZE) break
      if (bytes >= SAMPLE_BYTES) {
        bytesLimited = true
        break
      }
    }
  } finally {
    await cursor.close().catch(() => {})
  }
  return { profiler, method, bytesLimited }
}

function sampleFailure(error: unknown): string {
  const code = serverErrorCode(error)
  // Lost connections and aborts end the whole refresh instead.
  if (code === null) throw error
  if (code === UNAUTHORIZED) return "The source user may not read this collection."
  if (code === MAX_TIME_EXPIRED) {
    return `Sampling took longer than ${OPERATION_MAX_TIME_MS / 1000} seconds.`
  }
  return "MongoDB could not sample this collection."
}

/**
 * A random sample through $sample; where it is unavailable (some views and
 * servers), the first documents in natural order. A collection that cannot be
 * sampled is reported, not fatal.
 */
async function sample(collection: Collection, run: RunTag): Promise<Sample | { failure: string }> {
  try {
    return await readSample(
      collection.aggregate([{ $sample: { size: SAMPLE_SIZE } }], {
        ...READ_OPTIONS,
        allowDiskUse: false,
        ...run,
      }),
      "random",
    )
  } catch (error) {
    // Other server errors mean $sample is unavailable here, so the fallback below is tried.
    const code = serverErrorCode(error)
    const final =
      code === null || code === UNAUTHORIZED || code === MAX_TIME_EXPIRED || INTERRUPTED_CODES.has(code)
    if (final) return { failure: sampleFailure(error) }
  }
  try {
    return await readSample(
      collection.find({}, { ...READ_OPTIONS, limit: SAMPLE_SIZE, ...run }),
      "first",
    )
  } catch (error) {
    return { failure: sampleFailure(error) }
  }
}

async function estimatedDocuments(collection: Collection, run: RunTag): Promise<number | null> {
  try {
    return await collection.estimatedDocumentCount({
      maxTimeMS: OPERATION_MAX_TIME_MS,
      comment: run.comment,
    })
  } catch (error) {
    if (serverErrorCode(error) === null) throw error
    return null
  }
}

/** A $jsonSchema validator's descriptions: the collection's, and each property's by dotted path. */
function validatorDescriptions(options: Document | null): Map<string, string> {
  const descriptions = new Map<string, string>()
  const visit = (schema: unknown, path: string, depth: number) => {
    if (typeof schema !== "object" || schema === null || depth > 6) return
    const { description, properties, items } = schema as Document
    // PostgreSQL text cannot hold NUL, which BSON strings may contain.
    const text = typeof description === "string" ? description.replaceAll("\u0000", "").trim() : ""
    if (text) {
      descriptions.set(path, text.slice(0, MAX_COMMENT_CHARS))
    }
    if (typeof properties === "object" && properties !== null) {
      for (const [key, child] of Object.entries(properties as Document)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1)
      }
    }
    // Array items describe the same path, as MongoDB queries see it.
    if (typeof items === "object" && items !== null && !Array.isArray(items)) visit(items, path, depth)
  }
  visit((options?.validator as Document | undefined)?.$jsonSchema, "", 0)
  return descriptions
}

function viewDefinition(options: Document | null): string | null {
  if (!options?.viewOn) return null
  const definition = BSON.EJSON.stringify(
    { viewOn: options.viewOn, pipeline: options.pipeline ?? [] },
    undefined,
    2,
    { relaxed: true },
  )
  return definition.length <= MAX_VIEW_DEFINITION_CHARS ? definition : null
}

async function profileCollection(
  client: MongoClient,
  listed: ListedCollection,
  run: RunTag,
): Promise<DiscoveredObject> {
  const collection = client.db(listed.database).collection(listed.name)
  const isView = listed.type === "view"
  // Counting a view would run its whole pipeline.
  const estimatedRows = isView ? null : await estimatedDocuments(collection, run)
  run.signal.throwIfAborted()
  const result = await sample(collection, run)
  const descriptions = validatorDescriptions(listed.options)
  const sampled = "failure" in result ? null : result
  const columns = (sampled?.profiler.fields() ?? []).map((column) => ({
    ...column,
    comment: descriptions.get(column.name) ?? null,
  }))
  return {
    schema: listed.database,
    name: listed.name,
    kind: isView ? "view" : "collection",
    comment: descriptions.get("") ?? null,
    estimatedRows,
    viewDefinition: viewDefinition(listed.options),
    columns,
    keepColumns: sampled === null,
    details: {
      engine: "mongodb",
      collectionType: listed.type,
      capped: listed.options?.capped === true,
      sampleSize: sampled?.profiler.sampled ?? 0,
      sampleMethod: sampled?.method ?? "random",
      sampleBytesLimited: sampled?.bytesLimited ?? false,
      fieldsTruncated: sampled?.profiler.fieldsTruncated ?? false,
      depthTruncated: sampled?.profiler.depthTruncated ?? false,
      sampleFailure: "failure" in result ? result.failure : null,
    },
  }
}

/**
 * Kills this run's operations that are still running on the server. Aborting
 * only stops the driver waiting; any user may list and kill its own operations.
 */
async function killOperations(client: MongoClient, comment: string): Promise<void> {
  const admin = client.db("admin")
  const { inprog } = await admin.command({
    currentOp: 1,
    $ownOps: true,
    "command.comment": comment,
    maxTimeMS: OPERATION_MAX_TIME_MS,
  })
  for (const operation of Array.isArray(inprog) ? (inprog as { opid?: unknown }[]) : []) {
    if (operation.opid !== undefined) await admin.command({ killOp: 1, op: operation.opid })
  }
}

/**
 * Lists the collections and views of the requested databases and samples
 * each one to infer its fields. Every server operation carries maxTimeMS and
 * the refresh's abort signal; aborting also kills whatever is still running.
 */
export async function readMongoMetadata(
  client: MongoClient,
  request: DiscoveryRequest,
): Promise<DiscoveredMetadata> {
  const run: RunTag = { signal: request.signal, comment: `manifest-discovery-${randomUUID()}` }
  const stop = () => void killOperations(client, run.comment).catch(() => {})
  request.signal.addEventListener("abort", stop, { once: true })
  try {
    return await readAll(client, request, run)
  } finally {
    request.signal.removeEventListener("abort", stop)
  }
}

async function readAll(
  client: MongoClient,
  request: DiscoveryRequest,
  run: RunTag,
): Promise<DiscoveredMetadata> {
  const { schemas: databases, signal, onProgress } = request

  await onProgress({ phase: "reading_objects", objectsDone: 0, objectsTotal: null })
  const listed: ListedCollection[] = []
  for (const database of databases) {
    signal.throwIfAborted()
    listed.push(...(await listCollections(client.db(database), run)))
    if (listed.length > DISCOVERY_LIMITS.objects) {
      throw new DiscoveryLimitExceeded(
        `The selected databases have more than ${count(DISCOVERY_LIMITS.objects)} collections and views, the most one refresh reads. Select fewer databases.`,
      )
    }
  }
  listed.sort((a, b) => a.database.localeCompare(b.database) || a.name.localeCompare(b.name))

  const total = listed.length
  await onProgress({ phase: "reading_columns", objectsDone: 0, objectsTotal: total })
  const objects: DiscoveredObject[] = []
  let fields = 0
  let reportedAt = performance.now()
  for (const entry of listed) {
    signal.throwIfAborted()
    const object = await profileCollection(client, entry, run)
    fields += object.columns.length
    if (fields > DISCOVERY_LIMITS.columns) {
      throw new DiscoveryLimitExceeded(
        `The selected databases have more than ${count(DISCOVERY_LIMITS.columns)} fields, the most one refresh reads. Select fewer databases.`,
      )
    }
    objects.push(object)
    if (performance.now() - reportedAt >= PROGRESS_INTERVAL_MS || objects.length === total) {
      await onProgress({ phase: "reading_columns", objectsDone: objects.length, objectsTotal: total })
      reportedAt = performance.now()
    }
  }
  signal.throwIfAborted()
  // MongoDB declares no relationships; people add them by hand.
  return { objects, relationships: [] }
}
