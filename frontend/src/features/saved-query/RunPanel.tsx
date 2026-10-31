import { Play, Square } from "lucide-react"
import { useEffect, useId, useRef, useState, type FormEvent } from "react"

import { describeResult } from "@/entities/queries/cells.ts"
import { CsvDownloadButton } from "@/entities/queries/CsvDownloadButton.tsx"
import { ResultTable } from "@/entities/queries/ResultTable.tsx"
import { describeOutcome, describeRunError, type OutcomeNotice } from "@/entities/queries/run-outcome.ts"
import type { ExecutionRecord } from "@/entities/queries/types.ts"
import { useRunSavedQuery } from "@/entities/saved-queries/api.ts"
import {
  describeResolved,
  formatParameterValue,
  PARAMETER_TYPE_LABELS,
} from "@/entities/saved-queries/parameters.ts"
import type {
  ParameterDefinition,
  ResolvedParameter,
  SavedQueryDetail,
} from "@/entities/saved-queries/types.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input } from "@/shared/ui/fields.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

import { initialRunForm, runValues, type RunField, type RunForm } from "./run-form.ts"

type Shown =
  | { kind: "run"; execution: ExecutionRecord; parameters: ResolvedParameter[] }
  | { kind: "notice"; notice: OutcomeNotice }
  | null

const STOPPED: OutcomeNotice = {
  title: "Query stopped",
  message: "The request was closed, so the query was stopped on the source.",
}

function ParameterInput({
  definition,
  resolvedDefault,
  field,
  error,
  disabled,
  onChange,
}: {
  definition: ParameterDefinition
  resolvedDefault: ResolvedParameter | undefined
  field: RunField
  error: string | undefined
  disabled: boolean
  onChange: (field: RunField) => void
}) {
  const id = useId()
  const another = `Another ${definition.type === "date" ? "date" : "date and time"}`
  const input = (
    <Input
      id={`${id}-value`}
      type={definition.type === "date" ? "date" : "datetime-local"}
      value={field.value}
      disabled={disabled}
      aria-label={definition.default ? `${definition.label}: ${another.toLowerCase()}` : undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      className="w-auto"
      onChange={(event) => onChange({ mode: "value", value: event.target.value })}
    />
  )
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {definition.label}{" "}
        <span className="font-normal text-(--muted)">
          ({PARAMETER_TYPE_LABELS[definition.type].toLowerCase()}
          {definition.required ? "" : ", optional"})
        </span>
      </legend>
      {definition.default && resolvedDefault ? (
        <div className="space-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={id}
              checked={field.mode === "default"}
              disabled={disabled}
              className="accent-(--accent)"
              onChange={() => onChange({ ...field, mode: "default" })}
            />
            Default: {describeResolved(resolvedDefault)}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name={id}
                checked={field.mode === "value"}
                disabled={disabled}
                className="accent-(--accent)"
                onChange={() => onChange({ ...field, mode: "value" })}
              />
              {another}:
            </label>
            {input}
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor={`${id}-value`} className="sr-only">
            {definition.label}
          </label>
          {input}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-(--danger)">
          {error}
        </p>
      )}
    </fieldset>
  )
}

/** What a run resolved its parameters to, so the result says exactly what ran. */
function RanWith({ parameters }: { parameters: { label: string; text: string }[] }) {
  if (parameters.length === 0) return null
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {parameters.map((parameter) => (
        <div key={parameter.label} className="flex gap-1.5">
          <dt className="text-(--muted)">{parameter.label}:</dt>
          <dd className="font-medium">{parameter.text}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Runs a saved query: a form for its parameters (defaults shown as they
 * resolve now), Run and Stop, and the result with what it ran with. Before a
 * run it shows the latest stored result.
 */
export function RunPanel({ workspaceId, savedQuery }: { workspaceId: string; savedQuery: SavedQueryDetail }) {
  const headingId = useId()
  const [form, setForm] = useState<RunForm>(() => initialRunForm(savedQuery.parameters))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<Shown>(null)
  const [running, setRunning] = useState(false)
  const request = useRef<AbortController | null>(null)
  const run = useRunSavedQuery(workspaceId, savedQuery.id)

  // Leaving the page closes the request, which also stops the query on the source.
  useEffect(() => () => request.current?.abort(), [])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (running) return
    const built = runValues(savedQuery.parameters, form)
    if ("errors" in built) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    const controller = new AbortController()
    request.current = controller
    setRunning(true)
    setShown(null)
    run
      .mutateAsync({ parameters: built.values, signal: controller.signal })
      .then(
        (result) => setShown({ kind: "run", execution: result.execution, parameters: result.parameters }),
        (error: unknown) =>
          setShown({ kind: "notice", notice: controller.signal.aborted ? STOPPED : describeRunError(error) }),
      )
      .finally(() => {
        setRunning(false)
        request.current = null
      })
  }

  const latest = savedQuery.latestRun
  const execution = shown?.kind === "run" ? shown.execution : shown === null ? latest : null
  const notice = shown?.kind === "notice" ? shown.notice : execution ? describeOutcome(execution) : null
  const labels = new Map(savedQuery.parameters.map((parameter) => [parameter.name, parameter.label]))
  const ranWith =
    shown?.kind === "run"
      ? shown.parameters.map((parameter) => ({ label: parameter.label, text: describeResolved(parameter) }))
      : Object.entries(execution?.parameters ?? {}).map(([name, value]) => ({
          label: labels.get(name) ?? name,
          text: value === null ? "No value" : formatParameterValue(value),
        }))

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <h2 id={headingId} className="text-base font-semibold tracking-tight">
        Run
      </h2>
      <form onSubmit={submit} noValidate className="space-y-4">
        {savedQuery.parameters.length > 0 && (
          <div className="space-y-4 rounded-lg border border-(--border) p-4">
            {savedQuery.parameters.map((definition) => (
              <ParameterInput
                key={definition.name}
                definition={definition}
                resolvedDefault={savedQuery.defaults.find((parameter) => parameter.name === definition.name)}
                field={form[definition.name] ?? { mode: "value", value: "" }}
                error={errors[definition.name]}
                disabled={running}
                onChange={(field) => setForm((current) => ({ ...current, [definition.name]: field }))}
              />
            ))}
            <p className="text-xs text-(--muted)">
              Dates are in {savedQuery.timeZone}, the workspace time zone; relative ones resolve when the query
              runs.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={running}>
            <Play aria-hidden className="size-4" />
            {running ? "Running…" : "Run query"}
          </Button>
          {running && (
            <Button variant="secondary" onClick={() => request.current?.abort()}>
              <Square aria-hidden className="size-4" />
              Stop
            </Button>
          )}
        </div>
      </form>

      {running && <LoadingState label="Running the query…" />}
      {!running && notice && <FailureNotice title={notice.title} message={notice.message} />}
      {!running && execution?.result && (
        <div className="space-y-3">
          <p role="status" className="sr-only">
            Query finished: {describeResult(execution.result, execution.partialResult)}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-(--muted)">
              {shown?.kind === "run" ? "This run" : "Latest run"},{" "}
              <time dateTime={execution.createdAt} title={new Date(execution.createdAt).toLocaleString()}>
                {formatRelativeTime(execution.createdAt)}
              </time>
            </p>
            <CsvDownloadButton
              workspaceId={workspaceId}
              connectionId={execution.connectionId}
              executionId={execution.id}
              name={savedQuery.name}
              createdAt={execution.createdAt}
              partial={execution.truncated || execution.partialResult}
            />
          </div>
          <RanWith parameters={ranWith} />
          <ResultTable
            key={execution.id}
            result={execution.result}
            partial={execution.partialResult}
            label={`Result of ${savedQuery.name}`}
          />
        </div>
      )}
      {!running && !shown && !latest && (
        <p className="text-sm text-(--muted)">Not run yet. Run it to see its rows here.</p>
      )}
    </section>
  )
}
