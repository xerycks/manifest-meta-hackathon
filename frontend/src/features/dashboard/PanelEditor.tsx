import { ArrowDown, ArrowUp, Lock, Play, Plus, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Link } from "react-router-dom"

import { PanelBody } from "@/entities/dashboards/PanelBody.tsx"
import { holdsNumbers, movedIds, PANEL_KIND_LABELS } from "@/entities/dashboards/panel-config.ts"
import { DASHBOARD_LIMITS, type NumberFormat, type PanelKind } from "@/entities/dashboards/types.ts"
import { describeRunError } from "@/entities/queries/run-outcome.ts"
import type { ResultColumn } from "@/entities/queries/types.ts"
import { useRunSavedQuery, useSavedQueries, useSavedQuery } from "@/entities/saved-queries/api.ts"
import type { SavedQueryDetail } from "@/entities/saved-queries/types.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Input, Select } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

import { draftDefinition, firstNumberColumn, type PanelDraft, type PanelErrors } from "./panel-form.ts"

const KIND_OPTIONS: { value: PanelKind; label: string }[] = [
  { value: "table", label: PANEL_KIND_LABELS.table },
  { value: "number", label: PANEL_KIND_LABELS.number },
  { value: "markdown", label: PANEL_KIND_LABELS.markdown },
]
const FORMAT_OPTIONS: { value: NumberFormat; label: string }[] = [
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
]
const DECIMAL_CHOICES = ["0", "1", "2", "3", "4", "5", "6"]
const CURRENCY_HINT = "ISO 4217 code, e.g. USD, EUR, INR."

type SavedQueryState = ReturnType<typeof useSavedQuery>

function SavedQueryPicker({
  workspaceId,
  value,
  selected,
  error,
  disabled,
  onChange,
}: {
  workspaceId: string
  value: string
  selected: SavedQueryDetail | undefined
  error: string | undefined
  disabled: boolean
  onChange: (savedQueryId: string) => void
}) {
  const id = useId()
  const [searchInput, setSearchInput] = useState("")
  const search = useDebouncedValue(searchInput.trim(), 250)
  const savedQueries = useSavedQueries(workspaceId, search, "")
  const listed = savedQueries.data?.pages.flatMap((page) => page.savedQueries) ?? []
  const hint = savedQueries.isError
    ? `Saved queries could not be loaded. ${apiErrorMessage(savedQueries.error)}`
    : savedQueries.hasNextPage
      ? "Showing the most recently updated ones; search by name for others."
      : undefined

  return (
    <div className="space-y-2">
      <Field id={`${id}-search`} label="Find a saved query">
        <Input
          id={`${id}-search`}
          type="search"
          value={searchInput}
          maxLength={100}
          placeholder="Name or description…"
          disabled={disabled}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </Field>
      <Field id={`${id}-saved-query`} label="Saved query" error={error} hint={hint}>
        <Select
          {...described(`${id}-saved-query`, error, hint)}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">
            {savedQueries.isPending ? "Loading saved queries…" : "Choose a saved query"}
          </option>
          {value && selected && !listed.some((item) => item.id === value) && (
            <option value={value}>{selected.name}</option>
          )}
          {listed.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.source.name}){item.visibility === "private" ? " · only you" : ""}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

/** Runs a saved query that has no stored result yet, so the panel can be set up from its columns. */
function RunFirst({ workspaceId, savedQuery }: { workspaceId: string; savedQuery: SavedQueryDetail }) {
  const run = useRunSavedQuery(workspaceId, savedQuery.id)
  const request = useRef<AbortController | null>(null)
  // Closing the dialog closes the request, which also stops the query on the source.
  useEffect(() => () => request.current?.abort(), [])
  const needsValues = savedQuery.parameters.some((parameter) => parameter.required && !parameter.default)
  const failure = run.error ? describeRunError(run.error) : null
  const outcome = run.data?.execution.status !== "succeeded" ? run.data?.execution.error?.message : undefined

  return (
    <div className="space-y-2 rounded-md border border-(--border) bg-(--surface) p-3 text-sm">
      <p>
        “{savedQuery.name}” has not been run yet, so there are no columns to choose from or rows to preview. A
        table shows every column it returns.
      </p>
      {needsValues ? (
        <Link
          to={`/saved/${encodeURIComponent(savedQuery.id)}`}
          className="font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
        >
          Run it with values on its page
        </Link>
      ) : (
        <Button
          variant="secondary"
          disabled={run.isPending}
          onClick={() => {
            request.current = new AbortController()
            run.mutate({ parameters: {}, signal: request.current.signal })
          }}
        >
          <Play aria-hidden className="size-4" />
          {run.isPending ? "Running…" : "Run it now"}
        </Button>
      )}
      {failure && <FailureNotice title={failure.title} message={failure.message} />}
      {outcome && <FailureNotice title="The run did not succeed" message={outcome} />}
    </div>
  )
}

function ColumnSelect({
  id,
  label,
  value,
  columns,
  error,
  hint,
  optional,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: string
  /** The latest result's columns of numbers; null types the name instead. */
  columns: ResultColumn[] | null
  error: string | undefined
  hint?: string
  optional?: boolean
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <Field id={id} label={label} error={error} hint={hint}>
      {columns ? (
        <Select
          {...described(id, error, hint)}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{optional ? "No comparison" : "Choose a column"}</option>
          {value && !columns.some((column) => column.name === value) && (
            <option value={value}>{value}</option>
          )}
          {columns.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name} ({column.type})
            </option>
          ))}
        </Select>
      ) : (
        <Input
          {...described(id, error, hint)}
          value={value}
          disabled={disabled}
          maxLength={300}
          placeholder={optional ? "Leave empty for none" : "Column name"}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  )
}

function TableColumns({
  draft,
  columns,
  error,
  disabled,
  onChange,
}: {
  draft: PanelDraft
  columns: ResultColumn[] | null
  error: string | undefined
  disabled: boolean
  onChange: (columns: string[] | null) => void
}) {
  const id = useId()
  const [adding, setAdding] = useState("")
  if (!columns) {
    return <p className="text-sm text-(--muted)">The table shows every column of the result.</p>
  }
  const chosen = draft.columns
  const names = [...new Set(columns.map((column) => column.name))]
  const remaining = names.filter((name) => !chosen?.includes(name))
  const toAdd = remaining.includes(adding) ? adding : (remaining[0] ?? "")

  return (
    <div className="space-y-3">
      <Choice
        label="Columns"
        value={chosen === null ? "all" : "chosen"}
        options={[
          { value: "all", label: "All, in result order" },
          { value: "chosen", label: "Choose and order" },
        ]}
        onChange={(mode) => onChange(mode === "all" ? null : names.slice(0, DASHBOARD_LIMITS.tableColumns))}
      />
      {chosen !== null && (
        <div className="space-y-2">
          {chosen.length > 0 ? (
            <ol
              aria-label="Columns shown, in order"
              className="divide-y divide-(--border) rounded-md border border-(--border)"
            >
              {chosen.map((name, index) => (
                <li key={name} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 break-words">
                    {name}
                    {!names.includes(name) && <span className="text-(--danger)"> (not in the result)</span>}
                  </span>
                  <Button
                    variant="ghost"
                    className="p-1.5"
                    aria-label={`Move ${name} up`}
                    disabled={disabled || index === 0}
                    onClick={() => onChange(movedIds(chosen, index, -1))}
                  >
                    <ArrowUp aria-hidden className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="p-1.5"
                    aria-label={`Move ${name} down`}
                    disabled={disabled || index === chosen.length - 1}
                    onClick={() => onChange(movedIds(chosen, index, 1))}
                  >
                    <ArrowDown aria-hidden className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="p-1.5"
                    aria-label={`Remove ${name}`}
                    disabled={disabled}
                    onClick={() => onChange(chosen.filter((item) => item !== name))}
                  >
                    <X aria-hidden className="size-4" />
                  </Button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-(--muted)">No columns chosen.</p>
          )}
          {remaining.length > 0 && chosen.length < DASHBOARD_LIMITS.tableColumns && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <label htmlFor={`${id}-add`} className="text-sm font-medium">
                  Add a column
                </label>
                <Select
                  id={`${id}-add`}
                  className="mt-1"
                  value={toAdd}
                  disabled={disabled}
                  onChange={(event) => setAdding(event.target.value)}
                >
                  {remaining.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button
                variant="secondary"
                disabled={disabled || !toAdd}
                onClick={() => onChange([...chosen, toAdd])}
              >
                <Plus aria-hidden className="size-4" />
                Add
              </Button>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs font-medium text-(--danger)">{error}</p>}
    </div>
  )
}

/**
 * A panel's settings: its kind, its saved query, the kind's config, and a
 * title, with a live preview built from the saved query's latest stored
 * result. `selected` is the chosen saved query, loaded by the caller.
 */
export function PanelEditor({
  workspaceId,
  draft,
  errors,
  selected,
  fixedSavedQuery = false,
  disabled,
  onChange,
}: {
  workspaceId: string
  draft: PanelDraft
  errors: PanelErrors
  selected: SavedQueryState
  /** The saved query was chosen before the dialog opened (Add to dashboard). */
  fixedSavedQuery?: boolean
  disabled: boolean
  onChange: (draft: PanelDraft) => void
}) {
  const id = useId()
  const set = (changes: Partial<PanelDraft>) => onChange({ ...draft, ...changes })
  const savedQuery = draft.savedQueryId ? selected.data : undefined
  const latest = savedQuery?.latestRun?.result ?? null
  const columns = latest?.columns ?? null
  // A panel names columns by their first occurrence, so repeated names are offered once.
  const numberColumns =
    columns?.filter(
      (column, index) =>
        holdsNumbers(column) && columns.findIndex((other) => other.name === column.name) === index,
    ) ?? null
  const definition = draftDefinition(draft)
  const query = draft.kind !== "markdown"
  const previewable =
    draft.kind === "markdown"
      ? draft.body.trim() !== ""
      : latest !== null && (draft.kind === "table" || draft.valueColumn !== "")

  const decimalsHint =
    draft.format === "percent" ? "Percent values are ratios: 0.25 shows as 25%." : undefined
  const titleHint = query ? "Leave empty to use the saved query's name." : undefined

  function chooseKind(kind: PanelKind) {
    set(
      kind === "number" && !draft.valueColumn && columns
        ? { kind, valueColumn: firstNumberColumn(columns) }
        : { kind },
    )
  }

  return (
    <div className="space-y-5">
      <Choice
        label="Panel"
        value={draft.kind}
        options={
          fixedSavedQuery ? KIND_OPTIONS.filter((option) => option.value !== "markdown") : KIND_OPTIONS
        }
        onChange={chooseKind}
      />

      {query && !fixedSavedQuery && (
        <SavedQueryPicker
          workspaceId={workspaceId}
          value={draft.savedQueryId}
          selected={selected.data}
          error={errors.savedQueryId}
          disabled={disabled}
          onChange={(savedQueryId) => set({ savedQueryId })}
        />
      )}
      {query && fixedSavedQuery && errors.savedQueryId && (
        <FailureNotice title="Choose another saved query" message={errors.savedQueryId} />
      )}
      {query && draft.savedQueryId && selected.isPending && <LoadingState label="Loading the saved query…" />}
      {query && draft.savedQueryId && selected.isError && (
        <FailureNotice title="Saved query unavailable" message={apiErrorMessage(selected.error)} />
      )}
      {query && savedQuery && (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-(--muted)">
          {savedQuery.visibility === "private" && <Lock aria-hidden className="size-3.5" />}
          From “{savedQuery.name}” on {savedQuery.source.name}
          {savedQuery.visibility === "private" && " (only you can see it)"}
          {savedQuery.latestRun && (
            <>
              {" "}
              · latest run{" "}
              <time
                dateTime={savedQuery.latestRun.createdAt}
                title={new Date(savedQuery.latestRun.createdAt).toLocaleString()}
              >
                {formatRelativeTime(savedQuery.latestRun.createdAt)}
              </time>
            </>
          )}
        </p>
      )}
      {query && savedQuery && !savedQuery.latestRun && (
        <RunFirst workspaceId={workspaceId} savedQuery={savedQuery} />
      )}

      {draft.kind === "number" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <ColumnSelect
            id={`${id}-value`}
            label="Value column"
            value={draft.valueColumn}
            columns={numberColumns}
            error={errors.valueColumn}
            hint="The panel shows this column of the first row."
            disabled={disabled}
            onChange={(valueColumn) => set({ valueColumn })}
          />
          <ColumnSelect
            id={`${id}-comparison`}
            label="Compare with (optional)"
            value={draft.comparisonColumn}
            columns={numberColumns?.filter((column) => column.name !== draft.valueColumn) ?? null}
            error={errors.comparisonColumn}
            hint="Shows the difference, e.g. against last month."
            optional
            disabled={disabled}
            onChange={(comparisonColumn) => set({ comparisonColumn })}
          />
          <Choice
            label="Format"
            value={draft.format}
            options={FORMAT_OPTIONS}
            onChange={(format) => set({ format })}
          />
          <Field id={`${id}-decimals`} label="Decimal places" hint={decimalsHint}>
            <Select
              {...described(`${id}-decimals`, undefined, decimalsHint)}
              value={draft.decimals}
              disabled={disabled}
              onChange={(event) => set({ decimals: event.target.value })}
            >
              <option value="">As stored (every digit)</option>
              {DECIMAL_CHOICES.map((places) => (
                <option key={places} value={places}>
                  {places}
                </option>
              ))}
            </Select>
          </Field>
          {draft.format === "currency" && (
            <Field id={`${id}-currency`} label="Currency" error={errors.currency} hint={CURRENCY_HINT}>
              <Input
                {...described(`${id}-currency`, errors.currency, CURRENCY_HINT)}
                value={draft.currency}
                maxLength={3}
                autoCapitalize="characters"
                className="w-28 uppercase"
                disabled={disabled}
                onChange={(event) => set({ currency: event.target.value.toUpperCase() })}
              />
            </Field>
          )}
        </div>
      )}
      {draft.kind === "table" && (
        <TableColumns
          draft={draft}
          columns={columns}
          error={errors.columns}
          disabled={disabled}
          onChange={(chosen) => set({ columns: chosen })}
        />
      )}
      {draft.kind === "markdown" && (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-body`} className="text-sm font-medium">
            Text
          </label>
          <MarkdownEditor
            id={`${id}-body`}
            value={draft.body}
            onChange={(body) => set({ body })}
            maxLength={DASHBOARD_LIMITS.markdownChars}
            rows={6}
            placeholder="Context for the panels around it: what they measure, caveats, links…"
            describedBy={errors.body ? `${id}-body-error` : undefined}
            disabled={disabled}
          />
          {errors.body && (
            <p id={`${id}-body-error`} className="text-xs font-medium text-(--danger)">
              {errors.body}
            </p>
          )}
        </div>
      )}

      <Field id={`${id}-title`} label="Title (optional)" error={errors.title} hint={titleHint}>
        <Input
          {...described(`${id}-title`, errors.title, titleHint)}
          value={draft.title}
          maxLength={DASHBOARD_LIMITS.titleChars}
          placeholder={query ? (savedQuery?.name ?? "") : "e.g. How to read this dashboard"}
          disabled={disabled}
          onChange={(event) => set({ title: event.target.value })}
        />
      </Field>

      <section
        aria-label="Preview"
        className="space-y-2 rounded-lg border border-dashed border-(--border) p-4"
      >
        <h3 className="text-xs font-medium tracking-wide text-(--muted) uppercase">Preview</h3>
        {previewable ? (
          <PanelBody panel={definition} result={latest} label="Panel preview" />
        ) : (
          <p className="text-sm text-(--muted)">
            {draft.kind === "markdown"
              ? "Write the text to preview it."
              : !draft.savedQueryId
                ? "Choose a saved query to preview its latest result."
                : !latest
                  ? "The preview appears once the saved query has a result."
                  : "Choose the value column to preview the number."}
          </p>
        )}
      </section>
    </div>
  )
}
