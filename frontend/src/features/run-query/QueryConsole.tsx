import { Play, Square } from "lucide-react"
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react"

import type { Connection } from "@/entities/connections/types.ts"
import { useManifest } from "@/entities/manifests/api.ts"
import { useCancelQuery, useQueryExecution, useRunQuery } from "@/entities/queries/api.ts"
import { describeResult } from "@/entities/queries/cells.ts"
import { CsvDownloadButton } from "@/entities/queries/CsvDownloadButton.tsx"
import { ResultTable } from "@/entities/queries/ResultTable.tsx"
import { describeOutcome, describeRunError, type OutcomeNotice } from "@/entities/queries/run-outcome.ts"
import {
  QUERY_LIMITS,
  type ExecutionRecord,
  type ExecutionSummary,
  type ReadQuery,
} from "@/entities/queries/types.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Select, Textarea } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

import {
  buildQuery,
  draftFromQuery,
  emptyQueryDraft,
  type MongoOperation,
  type QueryDraft,
  type QueryDraftErrors,
} from "./query-draft.ts"
import { RecentRuns } from "./RecentRuns.tsx"

/** What the result area shows after a run: its record, or why the request failed. */
type Shown =
  | { kind: "record"; record: ExecutionRecord }
  | { kind: "notice"; notice: OutcomeNotice }
  | null

const OPERATIONS: { value: MongoOperation; label: string }[] = [
  { value: "find", label: "find" },
  { value: "aggregate", label: "aggregate" },
]

const CODE = "font-mono text-xs leading-5"
const SECONDS = QUERY_LIMITS.defaultTimeoutMs / 1000
const SQL_HINT = "Unqualified names must be tables or views in the manifest. Ctrl+Enter or ⌘+Enter runs it."
const FILTER_HINT =
  'Values may use Extended JSON, e.g. {"placed_at": {"$gte": {"$date": "2026-01-01T00:00:00Z"}}}.'
const PIPELINE_HINT =
  "An array of stages. $out, $merge, $where, $function, and $accumulator are never allowed; $lookup reads the same database only."
const ROWS_HINT = `1 to ${QUERY_LIMITS.maxRows.toLocaleString("en-US")}`
const CLOSED: OutcomeNotice = {
  title: "Query cancelled",
  message: "The request was closed, so the query was stopped on the source.",
}

/** A collection picker: the manifest's collections in the chosen database, or any name typed. */
function CollectionField({
  workspaceId,
  connectionId,
  database,
  value,
  error,
  onChange,
}: {
  workspaceId: string
  connectionId: string
  database: string
  value: string
  error: string | undefined
  onChange: (value: string) => void
}) {
  const id = useId()
  const manifest = useManifest(workspaceId, connectionId, "")
  const objects = manifest.data?.schemas.find((schema) => schema.name === database)?.objects ?? []
  const names = objects.map((object) => object.name)
  const hint =
    names.length > 0 ? undefined : "Type a name; collections appear here once the manifest is refreshed."
  return (
    <Field id={id} label="Collection" error={error} hint={hint}>
      <Input
        {...described(id, error, hint)}
        list={`${id}-options`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <datalist id={`${id}-options`}>
        {names.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </Field>
  )
}

/**
 * A small developer console for owners and admins: runs one read query on
 * the source with the same validation, limits, and records as every other
 * caller, and shows the rows or why there are none.
 */
export function QueryConsole({
  connection,
  workspaceId,
  saveAction,
}: {
  connection: Connection
  workspaceId: string
  /** E.g. "Save as query", given the query in the editor (or the shown run's) when it is used. */
  saveAction?: (currentQuery: () => ReadQuery | null) => ReactNode
}) {
  const ids = useId()
  const isSql = connection.engine === "postgres"
  const [draft, setDraft] = useState<QueryDraft>(() => emptyQueryDraft(connection.schemas))
  const [errors, setErrors] = useState<QueryDraftErrors>({})
  const [runningId, setRunningId] = useState<string | null>(null)
  const [shown, setShown] = useState<Shown>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const run = useRunQuery(workspaceId, connection.id)
  const cancel = useCancelQuery(workspaceId, connection.id)
  const opened = useQueryExecution(workspaceId, connection.id, openId)
  const request = useRef<AbortController | null>(null)

  // Leaving the page closes the request, which also stops the query on the source.
  useEffect(() => () => request.current?.abort(), [])

  const update = (changes: Partial<QueryDraft>) => {
    setDraft((current) => ({ ...current, ...changes }))
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(changes)) delete next[key as keyof QueryDraft]
      return next
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (runningId) return
    const built = buildQuery(draft, connection.engine)
    if ("errors" in built) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    const id = crypto.randomUUID()
    const controller = new AbortController()
    request.current = controller
    setRunningId(id)
    setOpenId(null)
    setShown(null)
    run
      .mutateAsync({ id, query: built.query, maxRows: built.maxRows, signal: controller.signal })
      .then(
        (record) => setShown({ kind: "record", record }),
        (error: unknown) =>
          setShown({
            kind: "notice",
            notice: controller.signal.aborted ? CLOSED : describeRunError(error),
          }),
      )
      .finally(() => {
        setRunningId(null)
        request.current = null
      })
  }

  function stop() {
    if (!runningId) return
    // If the run is not known to the server yet, closing the request stops it instead.
    cancel.mutate(runningId, { onError: () => request.current?.abort() })
  }

  function open(summary: ExecutionSummary) {
    setDraft((current) => draftFromQuery(summary.query, summary.limits.maxRows, current))
    setErrors({})
    setShown(null)
    setOpenId(summary.id)
  }

  function runOnModEnter(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.currentTarget.requestSubmit()
    }
  }

  const record = openId ? (opened.data ?? null) : shown?.kind === "record" ? shown.record : null
  const currentQuery = () => {
    const built = buildQuery(draft, connection.engine)
    return "query" in built ? built.query : (record?.query ?? null)
  }
  const notice = record ? describeOutcome(record) : shown?.kind === "notice" ? shown.notice : null
  const running = runningId !== null
  const field = (name: keyof QueryDraft) => `${ids}-${name}`
  const schemaList = connection.schemas.join(", ")

  return (
    <Card className="space-y-5">
      <div>
        <CardTitle>Run a read query</CardTitle>
        <CardDescription>
          {isSql
            ? `Runs one read-only SELECT on ${schemaList}, in a read-only transaction.`
            : `Runs a read-only find or aggregate on ${schemaList}. Stages that write or run JavaScript are refused.`}{" "}
          At most {QUERY_LIMITS.maxRows.toLocaleString("en-US")} rows, {QUERY_LIMITS.resultMegabytes} MB, and{" "}
          {SECONDS} seconds per run; every run is recorded.
        </CardDescription>
      </div>

      <form onSubmit={submit} onKeyDown={runOnModEnter} className="space-y-4" noValidate>
        {isSql ? (
          <Field
            id={field("sql")}
            label="SQL"
            error={errors.sql}
            hint={SQL_HINT}
          >
            <Textarea
              {...described(field("sql"), errors.sql, SQL_HINT)}
              value={draft.sql}
              onChange={(event) => update({ sql: event.target.value })}
              rows={8}
              spellCheck={false}
              placeholder="SELECT status, count(*) FROM orders GROUP BY status"
              className={CODE}
            />
          </Field>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={field("database")} label="Database" error={errors.database}>
                <Select
                  {...described(field("database"), errors.database)}
                  value={draft.database}
                  onChange={(event) => update({ database: event.target.value })}
                >
                  {connection.schemas.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <CollectionField
                workspaceId={workspaceId}
                connectionId={connection.id}
                database={draft.database}
                value={draft.collection}
                error={errors.collection}
                onChange={(collection) => update({ collection })}
              />
            </div>
            <Choice
              label="Operation"
              value={draft.operation}
              options={OPERATIONS}
              onChange={(operation) => update({ operation })}
            />
            {draft.operation === "find" ? (
              <>
                <Field
                  id={field("filter")}
                  label="Filter (JSON)"
                  error={errors.filter}
                  hint={FILTER_HINT}
                >
                  <Textarea
                    {...described(field("filter"), errors.filter, FILTER_HINT)}
                    value={draft.filter}
                    onChange={(event) => update({ filter: event.target.value })}
                    rows={4}
                    spellCheck={false}
                    className={CODE}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-[1fr_1fr_8rem]">
                  <Field id={field("projection")} label="Projection (optional)" error={errors.projection}>
                    <Textarea
                      {...described(field("projection"), errors.projection)}
                      value={draft.projection}
                      onChange={(event) => update({ projection: event.target.value })}
                      rows={2}
                      spellCheck={false}
                      placeholder='{"status": 1}'
                      className={CODE}
                    />
                  </Field>
                  <Field id={field("sort")} label="Sort (optional)" error={errors.sort}>
                    <Textarea
                      {...described(field("sort"), errors.sort)}
                      value={draft.sort}
                      onChange={(event) => update({ sort: event.target.value })}
                      rows={2}
                      spellCheck={false}
                      placeholder='{"placed_at": -1}'
                      className={CODE}
                    />
                  </Field>
                  <Field id={field("skip")} label="Skip" error={errors.skip}>
                    <Input
                      {...described(field("skip"), errors.skip)}
                      value={draft.skip}
                      onChange={(event) => update({ skip: event.target.value })}
                      inputMode="numeric"
                      placeholder="0"
                    />
                  </Field>
                </div>
              </>
            ) : (
              <Field
                id={field("pipeline")}
                label="Pipeline (JSON)"
                error={errors.pipeline}
                hint={PIPELINE_HINT}
              >
                <Textarea
                  {...described(field("pipeline"), errors.pipeline, PIPELINE_HINT)}
                  value={draft.pipeline}
                  onChange={(event) => update({ pipeline: event.target.value })}
                  rows={8}
                  spellCheck={false}
                  className={CODE}
                />
              </Field>
            )}
          </>
        )}

        <Field
          id={field("maxRows")}
          label="Row limit"
          error={errors.maxRows}
          hint={ROWS_HINT}
          className="w-40"
        >
          <Input
            {...described(field("maxRows"), errors.maxRows, ROWS_HINT)}
            type="number"
            min={1}
            max={QUERY_LIMITS.maxRows}
            inputMode="numeric"
            value={draft.maxRows}
            onChange={(event) => update({ maxRows: event.target.value })}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={running}>
            <Play aria-hidden className="size-4" />
            {running ? "Running…" : "Run query"}
          </Button>
          {running && (
            <Button variant="secondary" onClick={stop} disabled={cancel.isPending}>
              <Square aria-hidden className="size-4" />
              {cancel.isPending ? "Cancelling…" : "Cancel"}
            </Button>
          )}
        </div>
      </form>

      {saveAction && <div className="flex flex-wrap">{saveAction(currentQuery)}</div>}

      <section aria-labelledby={`${ids}-result`} className="space-y-3">
        <h3 id={`${ids}-result`} className="text-sm font-semibold">
          Result
          {openId && opened.data && (
            <span className="font-normal text-(--muted)">
              {" "}
              · stored run from {formatRelativeTime(opened.data.createdAt)}
            </span>
          )}
        </h3>
        {running && <LoadingState label="Running the query…" />}
        {!running && openId && opened.isPending && <LoadingState label="Opening the run…" />}
        {!running && openId && opened.isError && (
          <FailureNotice title="Could not open this run" message={opened.error.message} />
        )}
        {!running && notice && <FailureNotice title={notice.title} message={notice.message} />}
        {!running && record?.status === "running" && (
          <p className="text-sm text-(--muted)">This query is still running. Open it again once it ends.</p>
        )}
        {!running && record?.result && (
          <>
            <p role="status" className="sr-only">
              Query finished: {describeResult(record.result, record.partialResult)}
            </p>
            <CsvDownloadButton
              workspaceId={workspaceId}
              connectionId={connection.id}
              executionId={record.id}
              name={`${connection.name} query`}
              createdAt={record.createdAt}
              partial={record.truncated || record.partialResult}
            />
            <ResultTable
              key={record.id}
              result={record.result}
              partial={record.partialResult}
              label="Query result"
            />
          </>
        )}
        {!running && !openId && !shown && (
          <p className="text-sm text-(--muted)">Run a query to see its rows here.</p>
        )}
      </section>

      <RecentRuns workspaceId={workspaceId} connectionId={connection.id} openId={openId} onOpen={open} />
    </Card>
  )
}
