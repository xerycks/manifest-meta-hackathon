import type { MongoClient } from "mongodb"

import { MongoRows } from "../../queries/mongodb-values.js"
import type { ValidatedMongoQuery } from "../../queries/mongodb-validator.js"
import { ResultCollector } from "../../queries/results.js"
import type { QueryResult } from "../../queries/schemas.js"
import { killOperations } from "./mongodb-discovery.js"
import type { QueryRunRequest } from "./types.js"

const READ_OPTIONS = {
  batchSize: 200,
  // Keeps int, long, double, and decimal apart instead of turning them all into numbers.
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
  allowDiskUse: false,
} as const

/**
 * Runs a validated find or aggregate with maxTimeMS and a limit of
 * maxRows + 1. Every operation carries a comment naming the execution, so
 * aborting kills what is still running on the server, not just the wait.
 */
export async function readMongoRows(
  client: MongoClient,
  query: ValidatedMongoQuery,
  request: QueryRunRequest,
): Promise<QueryResult> {
  const { maxRows, timeoutMs } = request.limits
  const { signal } = request
  const comment = `manifest-query-${request.executionId}`
  const stop = () => void killOperations(client, comment).catch(() => {})
  signal.addEventListener("abort", stop, { once: true })

  const started = performance.now()
  const collection = client.db(query.database).collection(query.collection)
  const options = { ...READ_OPTIONS, maxTimeMS: timeoutMs, comment, signal }
  const cursor =
    query.operation === "find"
      ? collection.find(query.filter, {
          ...options,
          limit: maxRows + 1,
          ...(query.projection ? { projection: query.projection } : {}),
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.skip !== null ? { skip: query.skip } : {}),
        })
      : collection.aggregate([...query.pipeline, { $limit: maxRows + 1 }], options)

  const collector = new ResultCollector(maxRows)
  const rows = new MongoRows(collector)
  try {
    signal.throwIfAborted()
    for await (const document of cursor) {
      if (!rows.add(document)) break
    }
  } finally {
    signal.removeEventListener("abort", stop)
    await cursor.close().catch(() => {})
  }
  return {
    columns: rows.columns(),
    rows: collector.rows,
    rowCount: collector.rows.length,
    truncated: collector.full,
    truncatedBy: collector.truncatedBy,
    durationMs: Math.round(performance.now() - started),
  }
}
