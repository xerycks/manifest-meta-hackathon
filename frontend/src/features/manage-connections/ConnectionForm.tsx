import { CircleCheck, PlugZap } from "lucide-react"
import { useId, useState, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router-dom"

import {
  useConnectionSchemas,
  useCreateConnection,
  useTestConnection,
  useUpdateConnection,
} from "@/entities/connections/api.ts"
import type { Connection, ConnectionTestResult, SslMode } from "@/entities/connections/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { Checkbox, Input, Label, Select } from "@/shared/ui/fields.tsx"
import { LoadingState } from "@/shared/ui/states.tsx"

import {
  configFromDraft,
  describeConnectionError,
  draftErrors,
  draftFromConnection,
  emptyDraft,
  needsPasswordReentry,
  sameConnectionSettings,
  schemaOptions,
  SSL_MODE_OPTIONS,
  toCreateInput,
  toTestInput,
  toUpdateInput,
  type ConnectionDraft,
} from "./connection-form.ts"
import { FailureNotice } from "./FailureNotice.tsx"

function Field({
  id,
  label,
  error,
  hint,
  className,
  children,
}: {
  id: string
  label: string
  error?: string | undefined
  hint?: string | undefined
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-message`} className="text-xs font-medium text-(--danger)">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-message`} className="text-xs leading-5 text-(--muted)">
            {hint}
          </p>
        )
      )}
    </div>
  )
}

interface TestedSettings {
  draft: ConnectionDraft
  result: ConnectionTestResult
}

function described(id: string, error: string | undefined, hint?: string) {
  return {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error || hint ? `${id}-message` : undefined,
  }
}

/**
 * Add or edit a PostgreSQL source: settings → Test → choose schemas → Save.
 * With `connection`, the form edits it and an empty password keeps the saved one.
 * Failed tests and saves leave everything the user typed in place.
 */
export function ConnectionForm({
  workspaceId,
  connection,
  onSaved,
}: {
  workspaceId: string
  connection?: Connection
  onSaved: (connection: Connection) => void
}) {
  const ids = useId()
  const [draft, setDraft] = useState<ConnectionDraft>(() =>
    connection ? draftFromConnection(connection) : emptyDraft(),
  )
  const [selected, setSelected] = useState<string[]>(() => connection?.schemas ?? [])
  const [tested, setTested] = useState<TestedSettings | null>(null)
  const [showErrors, setShowErrors] = useState(false)

  const test = useTestConnection(workspaceId)
  const create = useCreateConnection(workspaceId)
  const update = useUpdateConnection(workspaceId, connection?.id ?? "")
  const liveSchemas = useConnectionSchemas(
    workspaceId,
    connection?.id ?? "",
    connection !== undefined,
  )
  const saving = create.isPending || update.isPending
  const saveError = connection ? update.error : create.error

  const errors = showErrors ? draftErrors(draft) : {}
  const testIsCurrent = tested !== null && sameConnectionSettings(tested.draft, draft)
  const settingsUnchanged =
    connection !== undefined && sameConnectionSettings(draftFromConnection(connection), draft)
  const reentry = connection ? needsPasswordReentry(connection, draft) : false
  const reentryMessage = reentry
    ? "Re-enter the password: the saved one is only reused for the same host, port, username, and SSL mode."
    : undefined

  const available = testIsCurrent
    ? tested.result.schemas
    : connection && liveSchemas.isSuccess
      ? liveSchemas.data
      : null
  const showSchemaList = connection !== undefined || testIsCurrent
  const options = showSchemaList ? schemaOptions(available, selected) : []

  const changes = connection ? toUpdateInput(connection, draft, selected) : null
  const saveBlocker = ((): string | null => {
    if (reentry) return "Re-enter the password to save new server settings."
    if (!configFromDraft(draft)) return "Complete the connection settings."
    if (!connection && !testIsCurrent) return "Test the connection, then choose schemas."
    if (!draft.name.trim()) return "Enter a name."
    if (selected.length === 0) return "Select at least one schema."
    if (changes && Object.keys(changes).length === 0) return "No changes to save yet."
    return null
  })()

  function setField<K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    if (test.isError) test.reset()
  }

  function runTest() {
    setShowErrors(true)
    const input = toTestInput(draft, connection?.id)
    if (!input || reentry) return
    const snapshot = draft
    test.mutate(input, {
      onSuccess: (result) => {
        setTested({ draft: snapshot, result })
        if (!connection) {
          // New sources only keep schemas the server offers; one schema is picked for you.
          setSelected((current) => {
            const kept = current.filter((name) => result.schemas.includes(name))
            return kept.length === 0 && result.schemas.length === 1 ? [...result.schemas] : kept
          })
        }
      },
    })
  }

  function toggleSchema(name: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...current, name] : current.filter((entry) => entry !== name),
    )
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    setShowErrors(true)
    if (saveBlocker || saving) return
    if (connection) {
      if (changes) update.mutate(changes, { onSuccess: onSaved })
    } else {
      const input = toCreateInput(draft, selected)
      if (input) create.mutate(input, { onSuccess: onSaved })
    }
  }

  const passwordHint = connection
    ? connection.hasPassword
      ? "Leave blank to keep the saved password."
      : "No password is saved for this source."
    : "Leave blank if this user signs in without a password."
  const passwordPlaceholder = connection?.hasPassword
    ? "Saved password is kept — type to replace it"
    : "Optional"
  const testFailure = test.isError ? describeConnectionError(test.error) : null

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardTitle>Connection settings</CardTitle>
        <CardDescription>
          Manifest reads schema metadata and runs read-only analysis. A read-only database user is
          recommended. The password is encrypted on the server and never shown again.
        </CardDescription>

        <div className="mt-5 grid gap-4 sm:grid-cols-6">
          <Field id={`${ids}-name`} label="Name" error={errors.name} className="sm:col-span-6">
            <Input
              {...described(`${ids}-name`, errors.name)}
              value={draft.name}
              onChange={(event) => setField("name", event.target.value)}
              placeholder="e.g. Production analytics"
              maxLength={120}
              autoComplete="off"
            />
          </Field>
          <Field id={`${ids}-host`} label="Host" error={errors.host} className="sm:col-span-4">
            <Input
              {...described(`${ids}-host`, errors.host)}
              value={draft.host}
              onChange={(event) => setField("host", event.target.value)}
              placeholder="db.example.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field id={`${ids}-port`} label="Port" error={errors.port} className="sm:col-span-2">
            <Input
              {...described(`${ids}-port`, errors.port)}
              value={draft.port}
              onChange={(event) => setField("port", event.target.value)}
              inputMode="numeric"
              autoComplete="off"
            />
          </Field>
          <Field
            id={`${ids}-database`}
            label="Database"
            error={errors.database}
            className="sm:col-span-3"
          >
            <Input
              {...described(`${ids}-database`, errors.database)}
              value={draft.database}
              onChange={(event) => setField("database", event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            id={`${ids}-username`}
            label="Username"
            error={errors.username}
            className="sm:col-span-3"
          >
            <Input
              {...described(`${ids}-username`, errors.username)}
              value={draft.username}
              onChange={(event) => setField("username", event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
          <Field
            id={`${ids}-password`}
            label="Password"
            error={reentryMessage}
            hint={passwordHint}
            className="sm:col-span-3"
          >
            <Input
              {...described(`${ids}-password`, reentryMessage, passwordHint)}
              type="password"
              value={draft.password}
              onChange={(event) => setField("password", event.target.value)}
              placeholder={passwordPlaceholder}
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
          <Field id={`${ids}-ssl`} label="SSL mode" className="sm:col-span-3">
            <Select
              id={`${ids}-ssl`}
              value={draft.sslMode}
              onChange={(event) => setField("sslMode", event.target.value as SslMode)}
            >
              {SSL_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-5 space-y-3">
          <Button variant="secondary" onClick={runTest} disabled={test.isPending || reentry}>
            <PlugZap aria-hidden className="size-4" />
            {test.isPending ? "Testing…" : "Test connection"}
          </Button>
          <div aria-live="polite">
            {testIsCurrent && (
              <p className="flex items-start gap-2 text-sm text-(--success)">
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
                Connected to PostgreSQL {tested.result.serverVersion} in{" "}
                {tested.result.latencyMs} ms.{" "}
                {tested.result.schemas.length === 1
                  ? "1 schema available."
                  : `${tested.result.schemas.length} schemas available.`}
              </p>
            )}
            {testFailure && <FailureNotice title={testFailure.title} message={testFailure.message} />}
          </div>
        </div>
      </Card>

      <Card>
        <fieldset>
          <legend className="text-base font-semibold tracking-tight">Schemas</legend>
          <CardDescription>
            Choose the schemas Manifest may document and query. System schemas are never listed.
          </CardDescription>

          <div className="mt-4 space-y-3">
            {!connection && !testIsCurrent && (
              <p className="text-sm text-(--muted)">
                {tested
                  ? "The connection settings changed. Test again to refresh the schema list."
                  : "Test the connection to see the schemas you can read."}
              </p>
            )}
            {connection && !testIsCurrent && (
              <>
                {liveSchemas.isPending && <LoadingState label="Reading schemas from the server…" />}
                {liveSchemas.isError && (
                  <FailureNotice
                    title="Could not list schemas with the saved settings"
                    message={`${describeConnectionError(liveSchemas.error).message} Your saved selection is shown below.`}
                  />
                )}
                {!settingsUnchanged && (
                  <p className="text-sm text-(--muted)">
                    You changed the connection settings. Saving tests them first; use Test
                    connection to refresh this list.
                  </p>
                )}
              </>
            )}
            {showSchemaList && available !== null && options.length === 0 && (
              <p className="text-sm text-(--muted)">
                This user cannot read any schemas in that database. Grant USAGE on a schema, then
                test again.
              </p>
            )}
            {options.length > 0 && (
              <ul className="grid gap-2 sm:grid-cols-2">
                {options.map((option) => (
                  <li key={option.name}>
                    <label className="flex items-center gap-2.5 rounded-md border border-(--border) px-3 py-2 text-sm">
                      <Checkbox
                        checked={selected.includes(option.name)}
                        onChange={(event) => toggleSchema(option.name, event.target.checked)}
                      />
                      <span className="min-w-0 break-all">{option.name}</span>
                      {option.missing && (
                        <span className="ml-auto text-xs text-(--danger)">not found on server</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </fieldset>
      </Card>

      {saveError && <FailureNotice {...describeConnectionError(saveError)} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || saveBlocker !== null}>
          {saving ? "Testing and saving…" : connection ? "Save changes" : "Save source"}
        </Button>
        <Link to="/sources" className={buttonVariants({ variant: "ghost" })}>
          Cancel
        </Link>
        {saveBlocker && (
          <p className="text-sm text-(--muted)" aria-live="polite">
            {saveBlocker}
          </p>
        )}
      </div>
    </form>
  )
}
