import { setTimeout as sleep } from "node:timers/promises"

import { z } from "zod"

import type { MongoFieldDetails } from "../connections/adapters/types.js"
import type { ConnectionsRepository } from "../connections/repository.js"
import type { KnowledgeRepository } from "../knowledge/repository.js"
import type { ManifestsRepository } from "../manifests/repository.js"
import type { ManifestRelationship } from "../manifests/schemas.js"
import type { QueryExecutionsRepository } from "../queries/repository.js"
import {
  readQuerySchema,
  type Cell,
  type ExecutionRecord,
  type ReadQuery,
  type ResultColumn,
} from "../queries/schemas.js"
import type { QueryExecutor } from "../queries/service.js"
import type { SearchRepository } from "../search/repository.js"
import { AppError } from "../shared/http/errors.js"
import { plainText, snippet } from "../shared/text.js"
import { AGENT_LIMITS, type AgentAnswer, type AgentToolName } from "./contracts.js"
import type { ToolDefinition } from "./provider.js"

/** Characters of JSON a tool returns to the model at most (beyond fixed fields). */
const OUTPUT_BUDGET = 12_000
/** Rows of a query result shown to the model; the execution record keeps the rest. */
const ROWS_SHOWN = 50
/** Text cells longer than this are shortened in what the model sees (evidence stays exact). */
const CELL_CHARS = 500
/** Characters of JSON rows stored with each cited execution. */
const EVIDENCE_CHARS = 50_000
const KNOWLEDGE_CHARS = 6_000
/** Limits on queries the agent runs; tighter than the console's maximums. */
const AGENT_QUERY_LIMITS = { maxRows: 1_000, timeoutMs: 30_000 } as const
const BUSY_RETRIES = 2
const BUSY_WAIT_MS = 1_500

/** A succeeded query of this run, kept so answers can cite it. */
export interface RunExecution {
  id: string
  connectionId: string
  query: ReadQuery
  columns: ResultColumn[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
}

export interface ToolContext {
  workspaceId: string
  userId: string
  /** The sources the run may use; null for every source of the workspace. */
  scope: string[] | null
  /** Aborting it stops a running query on its source. */
  signal: AbortSignal
  executions: Map<string, RunExecution>
}

export interface ToolSuccess {
  output: unknown
  /** A few words for progress, e.g. "42 rows". */
  summary: string
  executionId?: string
  /** Set by submit_answer once the answer is accepted. */
  answer?: AgentAnswer
}

/** A problem the model can recover from; the message is safe to show it and the user. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly executionId?: string,
  ) {
    super(message)
    this.name = "ToolError"
  }
}

export type PreparedCall =
  { summary: string; run(context: ToolContext): Promise<ToolSuccess> } | { error: string }

export interface AgentTool {
  name: AgentToolName
  definition: ToolDefinition
  /** Validates the model's input; a valid call can then run. */
  prepare(input: unknown): PreparedCall
}

export interface ToolServices {
  connections: ConnectionsRepository
  manifests: ManifestsRepository
  knowledge: KnowledgeRepository
  search: SearchRepository
  /** Null without CONNECTION_ENCRYPTION_KEY: queries cannot run. */
  executor: QueryExecutor | null
  executions: QueryExecutionsRepository
}

function inputError(name: string, error: z.ZodError): string {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
  return `Invalid input for ${name}: ${issues.join("; ")}. Fix the input and call it again.`
}

function tool<Schema extends z.ZodType>(spec: {
  name: AgentToolName
  description: string
  input: Schema
  describe(input: z.output<Schema>): string
  run(input: z.output<Schema>, context: ToolContext): Promise<ToolSuccess>
}): AgentTool {
  // Providers take the schema itself, without the JSON Schema dialect marker.
  const { $schema: _dialect, ...inputSchema } = z.toJSONSchema(spec.input, { io: "input" })
  return {
    name: spec.name,
    definition: { name: spec.name, description: spec.description, inputSchema },
    prepare(input) {
      const parsed = spec.input.safeParse(input ?? {})
      if (!parsed.success) return { error: inputError(spec.name, parsed.error) }
      return { summary: spec.describe(parsed.data), run: (context) => spec.run(parsed.data, context) }
    },
  }
}

/** The leading items whose JSON fits within `budget` characters. */
function fitting<T>(items: T[], budget: number): T[] {
  const kept: T[] = []
  let used = 0
  for (const item of items) {
    used += JSON.stringify(item).length + 1
    if (used > budget) break
    kept.push(item)
  }
  return kept
}

const clip = (text: string | null, max: number) => (text ? snippet(plainText(text), null, max) : null)
const shortCells = (row: Cell[]) =>
  row.map((cell) =>
    typeof cell === "string" && cell.length > CELL_CHARS ? `${cell.slice(0, CELL_CHARS)}…` : cell,
  )
const plural = (count: number, word: string, words = `${word}s`) => `${count} ${count === 1 ? word : words}`

function assertInScope(context: ToolContext, connectionId: string): void {
  if (context.scope && !context.scope.includes(connectionId)) {
    throw new ToolError(
      `Source ${connectionId} is not one of the sources for this question. Use list_sources to see them.`,
    )
  }
}

function sampled(details: MongoFieldDetails): string {
  if (details.sampleSize === 0) return "not sampled"
  const share = (documents: number) => `${Math.round((documents / details.sampleSize) * 100)}%`
  const parts = details.types.map((entry) => `${entry.type} ${share(entry.documents)}`)
  if (details.missing > 0) parts.push(`missing ${share(details.missing)}`)
  return parts.join(", ")
}

const end = (side: ManifestRelationship["from"]) => `${side.schema}.${side.name}(${side.columns.join(", ")})`

/** A query error for the model: the executor's safe message, or a plain one for a gone source. */
function queryStartFailure(error: AppError): ToolError {
  if (error.status === 404) {
    return new ToolError(
      "This source no longer exists (it may have been removed). Use list_sources to see the available sources.",
    )
  }
  if (error.code === "QUERY_BUSY") {
    return new ToolError("Too many queries are running on this source right now. Try again in a moment.")
  }
  return new ToolError(error.message)
}

export function createAgentTools(services: ToolServices): AgentTool[] {
  const listSources = tool({
    name: "list_sources",
    description:
      "List the data sources available for this question: id, name, engine, status, the schemas (PostgreSQL) or databases (MongoDB) Manifest may read, and what queries each accepts.",
    input: z.object({}),
    describe: () => "Listing sources",
    async run(_input, context) {
      const all = await services.connections.list(context.workspaceId)
      const sources = all
        .filter((source) => !context.scope || context.scope.includes(source.id))
        .map((source) => ({
          id: source.id,
          name: source.name,
          engine: source.engine,
          status: source.status,
          ...(source.status === "failed" && source.lastError ? { lastError: source.lastError } : {}),
          [source.engine === "postgres" ? "schemas" : "databases"]: source.schemas,
          queryLanguage: source.capabilities.queryLanguage,
          operations: source.capabilities.operations,
          capabilities: source.capabilities.summary,
        }))
      return { output: { sources }, summary: plural(sources.length, "source") }
    },
  })

  const searchMetadata = tool({
    name: "search_metadata",
    description:
      "Search table, view, collection, and column names and their documented meaning, and knowledge base entries (business definitions), by a word or phrase. Use it to find where something is stored or how a term is defined.",
    input: z.object({
      query: z.string().trim().min(1).max(100).describe("A word or phrase, e.g. refund or net revenue"),
      connectionId: z.uuid().optional().describe("Only this source"),
    }),
    describe: (input) => `Searching metadata for “${input.query}”`,
    async run(input, context) {
      if (input.connectionId) assertInScope(context, input.connectionId)
      const results = await services.search.search(context.workspaceId, { q: input.query, limit: 10 })
      const usable = (connectionId: string) =>
        (!context.scope || context.scope.includes(connectionId)) &&
        (!input.connectionId || input.connectionId === connectionId)
      const objects = results.objects
        .filter((hit) => hit.present && usable(hit.connectionId))
        .map((hit) => ({
          connectionId: hit.connectionId,
          objectId: hit.objectId,
          schema: hit.schema,
          name: hit.name,
          label: hit.label,
          kind: hit.kind,
          snippet: hit.snippet,
        }))
      const columns = results.columns
        .filter((hit) => hit.present && usable(hit.connectionId))
        .map((hit) => ({
          connectionId: hit.connectionId,
          objectId: hit.objectId,
          object: `${hit.objectSchema}.${hit.objectName}`,
          column: hit.name,
          label: hit.label,
          dataType: hit.dataType,
          snippet: hit.snippet,
        }))
      const knowledge = results.knowledge
        .filter((hit) => !hit.connection || usable(hit.connection.id))
        .map((hit) => ({ entryId: hit.entryId, title: hit.title, snippet: hit.snippet }))
      const third = Math.floor(OUTPUT_BUDGET / 3)
      const output = {
        objects: fitting(objects, third),
        columns: fitting(columns, third),
        knowledge: fitting(knowledge, third),
      }
      return {
        output,
        summary: [
          plural(output.objects.length, "object"),
          plural(output.columns.length, "column"),
          plural(output.knowledge.length, "entry", "entries"),
        ].join(", "),
      }
    },
  })

  const describeObject = tool({
    name: "describe_object",
    description:
      "Describe one table, view, or collection: its documented meaning, its columns or fields with types, labels, units, descriptions, and allowed values, and its relationships. Give objectId, or schema (MongoDB: database) and name.",
    input: z
      .object({
        connectionId: z.uuid(),
        objectId: z.uuid().optional(),
        schema: z.string().min(1).max(128).optional().describe("Schema, or MongoDB database"),
        name: z.string().min(1).max(255).optional().describe("Table, view, or collection name"),
      })
      .refine((input) => input.objectId || (input.schema && input.name), {
        message: "Give objectId, or both schema and name",
      }),
    describe: (input) =>
      `Describing ${input.schema && input.name ? `${input.schema}.${input.name}` : "an object"}`,
    async run(input, context) {
      assertInScope(context, input.connectionId)
      const objectId =
        input.objectId ??
        (await services.manifests.findObjectId(
          context.workspaceId,
          input.connectionId,
          input.schema ?? "",
          input.name ?? "",
        ))
      const detail = objectId
        ? await services.manifests.getObject(context.workspaceId, input.connectionId, objectId)
        : null
      if (!detail) {
        throw new ToolError(
          "No such table, view, or collection in this source. Check the outline in your instructions, or use search_metadata.",
        )
      }
      const { object } = detail
      const columns = detail.columns
        .filter((column) => column.present)
        .map((column) => ({
          name: column.name,
          type: column.dataType,
          ...(column.details ? { sampled: sampled(column.details) } : { nullable: column.nullable }),
          ...(column.isPrimaryKey ? { primaryKey: true } : {}),
          ...(column.label ? { label: column.label } : {}),
          ...(column.unit ? { unit: column.unit } : {}),
          ...(column.description ? { description: clip(column.description, 400) } : {}),
          ...(column.valueNotes ? { values: clip(column.valueNotes, 300) } : {}),
          ...(column.enumValues ? { enumValues: column.enumValues.slice(0, 30) } : {}),
          ...(column.comment ? { comment: clip(column.comment, 300) } : {}),
        }))
      const relationships = [...detail.outgoing, ...detail.incoming]
        .filter((relationship) => relationship.present && !relationship.needsReview)
        .map((relationship) => ({
          from: end(relationship.from),
          to: end(relationship.to),
          origin: relationship.origin,
          ...(relationship.remark ? { remark: clip(relationship.remark, 200) } : {}),
        }))
      const summary = {
        objectId: object.id,
        schema: object.schema,
        name: object.name,
        kind: object.kind,
        present: object.present,
        label: object.label,
        rowMeaning: object.rowMeaning,
        description: clip(object.description, 1_500),
        comment: clip(object.comment, 500),
        estimatedRows: object.estimatedRows,
      }
      const shownColumns = fitting(columns, OUTPUT_BUDGET - 2_000)
      const shownRelationships = fitting(relationships, 2_000)
      const omitted = {
        columns: columns.length - shownColumns.length,
        relationships: relationships.length - shownRelationships.length,
      }
      return {
        output: {
          object: summary,
          columns: shownColumns,
          relationships: shownRelationships,
          ...(omitted.columns > 0 || omitted.relationships > 0 ? { omitted } : {}),
        },
        summary: `${object.schema}.${object.name}: ${plural(columns.length, object.kind === "collection" ? "field" : "column")}`,
      }
    },
  })

  const readKnowledge = tool({
    name: "read_knowledge",
    description:
      "Read a knowledge base entry (a business definition such as how revenue is counted) by its id.",
    input: z.object({ entryId: z.uuid() }),
    describe: () => "Reading a knowledge entry",
    async run(input, context) {
      const entry = await services.knowledge.get(context.workspaceId, input.entryId)
      if (!entry) throw new ToolError("No knowledge entry with this id. Use search_metadata to find entries.")
      if (entry.connection && context.scope && !context.scope.includes(entry.connection.id)) {
        throw new ToolError("This knowledge entry is about a source that is not one of the sources for this question.")
      }
      return {
        output: {
          entryId: entry.id,
          title: entry.title,
          source: entry.connection,
          body: entry.body.slice(0, KNOWLEDGE_CHARS),
          ...(entry.body.length > KNOWLEDGE_CHARS ? { truncated: true } : {}),
        },
        summary: entry.title,
      }
    },
  })

  const runQuery = tool({
    name: "run_query",
    description: [
      `Run one read-only query on a source and get its columns and first ${ROWS_SHOWN} rows.`,
      'PostgreSQL sources take {"language":"sql","sql":"SELECT …"}: one SELECT (WITH allowed) on the source\'s schemas.',
      'MongoDB sources take {"language":"mongodb","database","collection","operation":"find","filter"?,"projection"?,"sort"?,"skip"?}',
      'or {"language":"mongodb","database","collection","operation":"aggregate","pipeline":[…]}.',
      "Aggregate in the query rather than reading raw rows;",
      `results stop at ${AGENT_QUERY_LIMITS.maxRows} rows and ${AGENT_QUERY_LIMITS.timeoutMs / 1000} seconds.`,
      "Returns an executionId to cite as evidence.",
    ].join(" "),
    input: z.object({
      connectionId: z.uuid(),
      query: readQuerySchema,
      purpose: z.string().trim().min(1).max(300).describe("What this query is for, in a few words"),
    }),
    describe: (input) => `Querying: ${snippet(input.purpose, null, 120)}`,
    async run(input, context) {
      assertInScope(context, input.connectionId)
      const executor = services.executor
      if (!executor) {
        throw new ToolError(
          "Queries cannot run: source credentials are unavailable because the backend has no CONNECTION_ENCRYPTION_KEY. Answer from metadata only and say what is missing.",
        )
      }
      let record: ExecutionRecord | null = null
      for (let attempt = 0; !record; attempt += 1) {
        try {
          record = await executor.execute({
            workspaceId: context.workspaceId,
            userId: context.userId,
            connectionId: input.connectionId,
            origin: "agent",
            query: input.query,
            limits: AGENT_QUERY_LIMITS,
            signal: context.signal,
          })
        } catch (error) {
          if (!(error instanceof AppError)) throw error
          // Busy is brief: wait a little before letting the model decide.
          if (error.code !== "QUERY_BUSY" || attempt >= BUSY_RETRIES) throw queryStartFailure(error)
          await sleep(BUSY_WAIT_MS, undefined, { signal: context.signal })
        }
      }
      const failure = record.error
      if (record.status === "rejected") {
        throw new ToolError(
          `QUERY_REJECTED (${failure?.reason ?? "not allowed"}): ${failure?.message ?? "This query is not allowed."}${failure?.name ? ` Offending name: ${failure.name}.` : ""}`,
          record.id,
        )
      }
      if (record.status === "cancelled") {
        context.signal.throwIfAborted()
        throw new ToolError("The query was cancelled before it finished.", record.id)
      }
      if (record.status !== "succeeded" || !record.result) {
        throw new ToolError(
          `${failure?.code ?? "QUERY_FAILED"}: ${failure?.message ?? "The query failed."}`,
          record.id,
        )
      }
      const result = record.result
      context.executions.set(record.id, {
        id: record.id,
        connectionId: input.connectionId,
        query: input.query,
        columns: result.columns,
        rows: fitting(result.rows.slice(0, AGENT_LIMITS.evidenceRows), EVIDENCE_CHARS),
        rowCount: result.rowCount,
        truncated: result.truncated,
      })
      const rows = fitting(result.rows.slice(0, ROWS_SHOWN).map(shortCells), OUTPUT_BUDGET)
      return {
        output: {
          executionId: record.id,
          columns: result.columns.map((column) => ({ name: column.name, type: column.type })),
          rows,
          rowCount: result.rowCount,
          ...(rows.length < result.rowCount ? { rowsShown: rows.length } : {}),
          truncated: result.truncated,
          ...(result.truncatedBy ? { truncatedBy: result.truncatedBy } : {}),
        },
        summary: `${plural(result.rowCount, "row")}${result.truncated ? " (more rows exist)" : ""}`,
        executionId: record.id,
      }
    },
  })

  const submitAnswer = tool({
    name: "submit_answer",
    description:
      'Submit the final answer in Markdown, citing as evidence the run_query executions of this conversation turn that support its numbers. Use status "partial" and list what is missing when the data cannot fully answer the question. Call it once, at the end.',
    input: z.object({
      markdown: z.string().trim().min(1).max(AGENT_LIMITS.answerChars),
      evidence: z
        .array(
          z.object({
            executionId: z.uuid().describe("An executionId returned by run_query"),
            label: z.string().trim().min(1).max(200).describe("What this result supports"),
          }),
        )
        .max(AGENT_LIMITS.evidenceItems)
        .default([]),
      status: z.enum(["complete", "partial"]),
      missing: z.array(z.string().trim().min(1).max(300)).max(AGENT_LIMITS.missingItems).optional(),
    }),
    describe: () => "Submitting the answer",
    async run(input, context) {
      const cited = [...new Map(input.evidence.map((item) => [item.executionId, item])).values()]
      const resolved = cited.flatMap((item) => {
        const execution = context.executions.get(item.executionId)
        return execution ? [{ label: item.label, execution }] : []
      })
      const unknown = cited.filter((item) => !context.executions.has(item.executionId))
      if (unknown.length > 0) {
        throw new ToolError(
          `Evidence must cite succeeded run_query executions from this run. Not found: ${unknown.map((item) => item.executionId).join(", ")}. Use the executionId values run_query returned, then submit again.`,
        )
      }
      const ids = cited.map((item) => item.executionId)
      const pinned = new Set(ids.length > 0 ? await services.executions.pin(context.workspaceId, ids) : [])
      const gone = ids.filter((id) => !pinned.has(id))
      if (gone.length > 0) {
        throw new ToolError(
          `These executions are no longer stored: ${gone.join(", ")}. Run those queries again.`,
        )
      }
      const answer: AgentAnswer = {
        markdown: input.markdown,
        status: input.status,
        missing: input.missing ?? [],
        evidence: resolved.map(({ label, execution }) => ({
          executionId: execution.id,
          connectionId: execution.connectionId,
          label,
          query: execution.query,
          columns: execution.columns,
          rows: execution.rows,
          rowCount: execution.rowCount,
          truncated: execution.truncated,
        })),
      }
      return { output: { accepted: true }, summary: "Answer submitted", answer }
    },
  })

  return [listSources, searchMetadata, describeObject, readKnowledge, runQuery, submitAnswer]
}
