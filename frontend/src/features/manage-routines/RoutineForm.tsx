import { useId, useMemo, useState, type FormEvent } from "react"

import { useConnections } from "@/entities/connections/api.ts"
import { ENGINE_LABELS } from "@/entities/connections/engine.ts"
import { useCreateRoutine, useUpdateRoutine } from "@/entities/routines/api.ts"
import { ROUTINE_LIMITS, type RoutineDetail } from "@/entities/routines/types.ts"
import { useSavedQueries, useSavedQuery } from "@/entities/saved-queries/api.ts"
import { ApiError } from "@/shared/api/client.ts"
import { apiErrorMessage, staleRecord } from "@/shared/lib/draft.ts"
import { useDebouncedValue } from "@/shared/lib/use-debounced-value.ts"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Checkbox, Input, Label, Select, Textarea } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
import { MarkdownEditor } from "@/shared/ui/markdown-editor.tsx"

import { ParameterOverrides } from "./ParameterOverrides.tsx"
import {
  draftFromRoutine,
  isEmptyPatch,
  newRoutineDraft,
  routineInput,
  routinePatch,
  type RoutineDraft,
  type RoutineErrors,
} from "./routine-form.ts"
import { ScheduleBuilder } from "./ScheduleBuilder.tsx"

const QUESTION_HINT =
  "Asked as the routine's owner in the routine's own conversation. No one can answer a clarification, so make it specific."

/** Search the workspace's saved queries and pick one; the current choice stays listed. */
function SavedQueryPicker({
  workspaceId,
  value,
  error,
  onChange,
}: {
  workspaceId: string
  value: string
  error: string | undefined
  onChange: (savedQueryId: string) => void
}) {
  const id = useId()
  const [search, setSearch] = useState("")
  const debounced = useDebouncedValue(search.trim(), 300)
  const list = useSavedQueries(workspaceId, debounced, "")
  const selected = useSavedQuery(workspaceId, value)
  const options = useMemo(() => {
    const found = (list.data?.pages ?? []).flatMap((page) => page.savedQueries)
    const chosen = selected.data
    return chosen && !found.some((item) => item.id === chosen.id) ? [chosen, ...found] : found
  }, [list.data, selected.data])
  return (
    <div className="space-y-3">
      <div className="max-w-md space-y-1.5">
        <Label htmlFor={`${id}-search`}>Find a saved query</Label>
        <Input
          id={`${id}-search`}
          type="search"
          value={search}
          placeholder="Search by name or description"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Field id={`${id}-query`} label="Saved query" error={error} className="max-w-md">
        <Select
          {...described(`${id}-query`, error)}
          value={value}
          disabled={list.isPending && options.length === 0}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">{list.isPending ? "Loading saved queries…" : "Choose a saved query"}</option>
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.source.name})
            </option>
          ))}
        </Select>
      </Field>
      {list.isSuccess && options.length === 0 && (
        <p className="text-sm text-(--muted)">
          {debounced ? "No saved queries match." : "No saved queries yet. Save an answer's query first."}
        </p>
      )}
      {list.isError && (
        <FailureNotice title="Saved queries unavailable" message={apiErrorMessage(list.error)} />
      )}
    </div>
  )
}

/** Which sources a question may use; none chosen means all of them. */
function SourceChoice({
  workspaceId,
  value,
  onChange,
}: {
  workspaceId: string
  value: string[]
  onChange: (ids: string[]) => void
}) {
  const sources = useConnections(workspaceId)
  const listed = sources.data ?? []
  // Sources removed since the routine was saved drop out as soon as the choice changes.
  const chosen = value.filter((sourceId) => listed.some((source) => source.id === sourceId))
  const full = chosen.length >= ROUTINE_LIMITS.connectionsPerRoutine
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Sources</legend>
      {sources.isPending && <p className="text-sm text-(--muted)">Loading sources…</p>}
      {sources.isError && (
        <FailureNotice title="Sources unavailable" message={apiErrorMessage(sources.error)} />
      )}
      {sources.isSuccess && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={value.length === 0} onChange={() => onChange([])} />
            All sources
          </label>
          {listed.map((source) => {
            const checked = chosen.includes(source.id)
            return (
              <label key={source.id} className="flex min-w-0 items-center gap-2 text-sm">
                <Checkbox
                  checked={checked}
                  disabled={!checked && full}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...chosen, source.id]
                        : chosen.filter((item) => item !== source.id),
                    )
                  }
                />
                <span className="truncate">{source.name}</span>
                <span className="shrink-0 text-xs text-(--muted)">{ENGINE_LABELS[source.engine]}</span>
              </label>
            )
          })}
          {chosen.length < value.length && (
            <p className="text-xs text-(--danger)">
              A source this routine used was removed, so its runs fail. Change the sources to save it without that
              source.
            </p>
          )}
        </>
      )}
    </fieldset>
  )
}

/**
 * Creates a routine or edits one: what it runs (a saved query with parameter
 * values, or a question for the agent), when (a schedule in a time zone with
 * a preview), and whether it runs on schedule. A failed save keeps
 * everything; an edit someone saved first says so, and saving again puts
 * these changes on top of theirs.
 */
export function RoutineForm({
  workspaceId,
  routine,
  initial,
  onSaved,
  onCancel,
}: {
  workspaceId: string
  /** The routine to edit, or null to create one. */
  routine: RoutineDetail | null
  /** For a new routine: the saved query to start from and the zone to start in. */
  initial?: { savedQueryId?: string; timeZone: string }
  onSaved: (routine: RoutineDetail) => void
  onCancel: () => void
}) {
  const id = useId()
  const [draft, setDraft] = useState<RoutineDraft>(() =>
    routine ? draftFromRoutine(routine) : newRoutineDraft(initial ?? { timeZone: "UTC" }),
  )
  const [errors, setErrors] = useState<RoutineErrors>({})
  const [version, setVersion] = useState(routine?.version ?? 1)
  const [conflict, setConflict] = useState(false)
  const create = useCreateRoutine(workspaceId)
  const update = useUpdateRoutine(workspaceId, routine?.id ?? "")
  const selected = useSavedQuery(workspaceId, draft.kind === "saved_query" ? draft.savedQueryId : "")
  const saving = create.isPending || update.isPending
  const error = routine ? update.error : create.error
  // A saved query the editor cannot open (private to the owner) keeps its stored values.
  const hidden = selected.error instanceof ApiError && selected.error.status === 404
  const loadingQuery = draft.kind === "saved_query" && draft.savedQueryId !== "" && selected.isPending
  const set = <K extends keyof RoutineDraft>(key: K, value: RoutineDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  function submit(event: FormEvent) {
    event.preventDefault()
    if (saving || loadingQuery) return
    // Without the saved query's definitions (private to its owner, or not loaded), stored values are kept.
    const built = routineInput(draft, selected.data?.parameters ?? null)
    if ("errors" in built) {
      setErrors(built.errors)
      return
    }
    setErrors({})
    setConflict(false)
    if (!routine) {
      create.mutate(built.input, { onSuccess: onSaved })
      return
    }
    const patch = routinePatch(version, routine, built.input)
    if (isEmptyPatch(patch)) {
      onCancel()
      return
    }
    update.mutate(patch, {
      onSuccess: onSaved,
      onError: (caught) => {
        const current = staleRecord<RoutineDetail>(caught)
        if (!current) return
        setVersion(current.version)
        setConflict(true)
      },
    })
  }

  return (
    <form
      aria-label={routine ? `Edit ${routine.name}` : "New routine"}
      className="space-y-6"
      noValidate
      onSubmit={submit}
    >
      <div className="space-y-4">
        <Field id={`${id}-name`} label="Name" error={errors.name}>
          <Input
            {...described(`${id}-name`, errors.name)}
            value={draft.name}
            maxLength={ROUTINE_LIMITS.nameChars}
            placeholder="e.g. Weekday order summary"
            autoFocus
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-description`} className="text-sm font-medium">
            Description (optional)
          </label>
          <MarkdownEditor
            id={`${id}-description`}
            value={draft.description}
            onChange={(value) => set("description", value)}
            maxLength={ROUTINE_LIMITS.descriptionChars}
            rows={3}
            placeholder="What it is for and who looks at it…"
          />
        </div>
      </div>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold tracking-tight">What it runs</legend>
        <Choice
          label="Kind"
          value={draft.kind}
          options={[
            { value: "saved_query", label: "A saved query" },
            { value: "question", label: "A question" },
          ]}
          onChange={(kind) => set("kind", kind)}
        />
        {draft.kind === "saved_query" ? (
          <>
            {hidden ? (
              <p className="text-sm text-(--muted)">
                It runs a saved query that is private to its owner. Its parameters stay as they are.
              </p>
            ) : (
              <SavedQueryPicker
                workspaceId={workspaceId}
                value={draft.savedQueryId}
                error={errors.savedQueryId}
                onChange={(savedQueryId) => set("savedQueryId", savedQueryId)}
              />
            )}
            {selected.isError && !hidden && (
              <FailureNotice title="Saved query unavailable" message={apiErrorMessage(selected.error)} />
            )}
            {selected.data && (
              <ParameterOverrides
                definitions={selected.data.parameters}
                overrides={draft.overrides}
                errors={errors.parameters}
                onChange={(overrides) => set("overrides", overrides)}
              />
            )}
          </>
        ) : (
          <>
            <Field
              id={`${id}-question`}
              label="Question"
              error={errors.question}
              hint={QUESTION_HINT}
            >
              <Textarea
                {...described(`${id}-question`, errors.question, QUESTION_HINT)}
                value={draft.question}
                maxLength={ROUTINE_LIMITS.questionChars}
                rows={3}
                placeholder="e.g. How many orders were refunded yesterday, by channel?"
                onChange={(event) => set("question", event.target.value)}
              />
            </Field>
            <SourceChoice
              workspaceId={workspaceId}
              value={draft.connectionIds}
              onChange={(ids) => set("connectionIds", ids)}
            />
          </>
        )}
      </fieldset>

      <ScheduleBuilder
        workspaceId={workspaceId}
        preset={draft.schedule}
        timeZone={draft.timeZone}
        scheduleError={errors.schedule}
        timeZoneError={errors.timeZone}
        onPresetChange={(schedule) => set("schedule", schedule)}
        onTimeZoneChange={(timeZone) => set("timeZone", timeZone)}
      />

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={draft.enabled} onChange={(event) => set("enabled", event.target.checked)} />
          Run on this schedule
        </label>
        <p className="text-xs leading-5 text-(--muted)">
          Unchecked, the routine is paused: it runs only when someone runs it now. Results stay in Manifest, in
          the routine's run history{draft.kind === "question" ? " and its conversation" : ""}.
        </p>
      </div>

      {conflict ? (
        <p
          role="alert"
          className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-sm leading-6 text-(--warning)"
        >
          Someone changed this routine after you opened it. Your changes are still here: save again to put them
          on top of theirs, or cancel to keep their version.
        </p>
      ) : (
        error && <FailureNotice title="Not saved" message={apiErrorMessage(error)} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving || loadingQuery}>
          {saving ? "Saving…" : routine ? "Save changes" : "Create routine"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
