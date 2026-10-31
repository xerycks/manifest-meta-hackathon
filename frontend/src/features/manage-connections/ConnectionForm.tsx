import { CircleCheck, Eye, EyeOff, PlugZap } from "lucide-react"
import { useId, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"

import {
  useConnectionSchemas,
  useCreateConnection,
  useTestConnection,
  useUpdateConnection,
} from "@/entities/connections/api.ts"
import { ENGINE_LABELS, ENGINE_TERMS } from "@/entities/connections/engine.ts"
import type {
  Connection,
  ConnectionEngine,
  ConnectionTestResult,
  SslMode,
} from "@/entities/connections/types.ts"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { Card, CardDescription, CardTitle } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"
import { Checkbox, Input, Select } from "@/shared/ui/fields.tsx"
import { Choice, described, Field } from "@/shared/ui/form-field.tsx"
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
  withEngine,
  type ConnectionDraft,
  type MongoMode,
} from "./connection-form.ts"

interface TestedSettings {
  draft: ConnectionDraft
  result: ConnectionTestResult
}

const ENGINE_OPTIONS = (["postgres", "mongodb"] as const).map((engine) => ({
  value: engine,
  label: ENGINE_LABELS[engine],
}))

const MONGO_MODE_OPTIONS: { value: MongoMode; label: string }[] = [
  { value: "fields", label: "Host and port" },
  { value: "uri", label: "Connection string" },
]

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Add or edit a PostgreSQL or MongoDB source: settings → Test → choose
 * schemas (MongoDB: databases) → Save. With `connection`, the form edits it
 * and empty secrets keep the saved ones. Failed tests and saves leave
 * everything the user typed in place.
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
  const [showUri, setShowUri] = useState(false)

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

  const engine = draft.engine
  const terms = ENGINE_TERMS[engine]
  const isMongo = engine === "mongodb"
  const uriMode = isMongo && draft.mongoMode === "uri"
  const savedUri =
    connection?.engine === "mongodb" && connection.config.mode === "uri" ? connection.config : null

  const errors = showErrors ? draftErrors(draft, savedUri !== null) : {}
  const testIsCurrent = tested !== null && sameConnectionSettings(tested.draft, draft)
  const settingsUnchanged =
    connection !== undefined && sameConnectionSettings(draftFromConnection(connection), draft)
  const reentry = connection ? needsPasswordReentry(connection, draft) : false
  const reentryMessage = reentry
    ? savedUri
      ? "Enter the password: the saved connection string is not reused for host-and-port settings."
      : "Re-enter the password: the saved one is only reused for the same host, port, username, and security settings."
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
    if (reentry) return "Enter the password to save new server settings."
    if (!configFromDraft(draft, savedUri !== null)) return "Complete the connection settings."
    if (!connection && !testIsCurrent) return `Test the connection, then choose ${terms.schemas}.`
    if (!draft.name.trim()) return "Enter a name."
    if (selected.length === 0) return `Select at least one ${terms.schema}.`
    if (changes && Object.keys(changes).length === 0) return "No changes to save yet."
    return null
  })()

  function setField<K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    if (test.isError) test.reset()
  }

  function chooseEngine(next: ConnectionEngine) {
    setDraft((current) => withEngine(current, next))
    // Schemas of one engine mean nothing to the other.
    setSelected([])
    setShowErrors(false)
    test.reset()
  }

  function runTest() {
    setShowErrors(true)
    const input = toTestInput(draft, connection)
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

  const savedPassword = connection?.hasPassword && !savedUri
  const passwordHint = connection
    ? savedPassword
      ? "Leave blank to keep the saved password."
      : "No password is saved for this source."
    : isMongo
      ? "Leave blank if the server does not require sign-in."
      : "Leave blank if this user signs in without a password."
  const passwordPlaceholder = savedPassword ? "Saved password is kept — type to replace it" : "Optional"
  const uriHint = savedUri
    ? `Saved for ${savedUri.hosts.join(", ")}${savedUri.database ? ` (database ${savedUri.database})` : ""}. Leave blank to keep it.`
    : "Includes the username and password. It is encrypted on the server and never shown again."
  const databaseHint = isMongo ? "Offered on its own if this user may not list databases." : undefined
  const authSourceHint = "Where the user is defined. Leave blank for admin."
  const testFailure = test.isError ? describeConnectionError(test.error) : null

  return (
    <form method="post" noValidate onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardTitle>{connection ? `${ENGINE_LABELS[engine]} connection settings` : "Connection settings"}</CardTitle>
        <CardDescription>
          Manifest reads {isMongo ? "collection metadata and samples documents" : "schema metadata"} and
          runs read-only analysis. A read-only database user is recommended. Passwords and connection
          strings are encrypted on the server and never shown again.
        </CardDescription>

        <div className="mt-5 flex flex-wrap gap-x-8 gap-y-4">
          {!connection && (
            <Choice label="Database type" value={engine} options={ENGINE_OPTIONS} onChange={chooseEngine} />
          )}
          {isMongo && (
            <Choice
              label="Connect with"
              value={draft.mongoMode}
              options={MONGO_MODE_OPTIONS}
              onChange={(mode) => setField("mongoMode", mode)}
            />
          )}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-6">
          <Field id={`${ids}-name`} label="Name" error={errors.name} className="sm:col-span-6">
            <Input
              {...described(`${ids}-name`, errors.name)}
              value={draft.name}
              onChange={(event) => setField("name", event.target.value)}
              placeholder={isMongo ? "e.g. Web analytics" : "e.g. Production analytics"}
              maxLength={120}
              autoComplete="off"
            />
          </Field>

          {uriMode ? (
            <Field
              id={`${ids}-uri`}
              label="Connection string"
              error={errors.uri}
              hint={uriHint}
              className="sm:col-span-6"
            >
              <div className="flex gap-2">
                <Input
                  {...described(`${ids}-uri`, errors.uri, uriHint)}
                  type={showUri ? "text" : "password"}
                  value={draft.uri}
                  onChange={(event) => setField("uri", event.target.value)}
                  placeholder={
                    savedUri
                      ? "Saved connection string is kept — paste a new one to replace it"
                      : "mongodb+srv://user:password@cluster.example.net/database"
                  }
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
                <Button
                  variant="secondary"
                  className="shrink-0 px-2.5"
                  aria-pressed={showUri}
                  aria-label={showUri ? "Hide connection string" : "Show connection string"}
                  onClick={() => setShowUri((shown) => !shown)}
                >
                  {showUri ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
                </Button>
              </div>
            </Field>
          ) : (
            <>
              <Field id={`${ids}-host`} label="Host" error={errors.host} className="sm:col-span-4">
                <Input
                  {...described(`${ids}-host`, errors.host)}
                  value={draft.host}
                  onChange={(event) => setField("host", event.target.value)}
                  placeholder={isMongo ? "mongo.example.com" : "db.example.com"}
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
                hint={databaseHint}
                className="sm:col-span-3"
              >
                <Input
                  {...described(`${ids}-database`, errors.database, databaseHint)}
                  value={draft.database}
                  onChange={(event) => setField("database", event.target.value)}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </Field>
              <Field
                id={`${ids}-username`}
                label={isMongo ? "Username (optional)" : "Username"}
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
              {isMongo ? (
                <Field
                  id={`${ids}-auth-source`}
                  label="Authentication database"
                  error={errors.authSource}
                  hint={authSourceHint}
                  className="sm:col-span-3"
                >
                  <Input
                    {...described(`${ids}-auth-source`, errors.authSource, authSourceHint)}
                    value={draft.authSource}
                    onChange={(event) => setField("authSource", event.target.value)}
                    placeholder="admin"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              ) : (
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
              )}
              {isMongo && (
                <div className="sm:col-span-6">
                  <label className="flex items-start gap-2.5 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={draft.tls}
                      onChange={(event) => setField("tls", event.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Use TLS</span>
                      <span className="block text-xs leading-5 text-(--muted)">
                        Encrypted, with the server certificate verified. Turn off only for a trusted
                        local or private network. For other TLS options, use a connection string.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </>
          )}
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
                Connected to {ENGINE_LABELS[engine]} {tested.result.serverVersion} in{" "}
                {tested.result.latencyMs} ms.{" "}
                {plural(tested.result.schemas.length, terms.schema, terms.schemas)} available.
              </p>
            )}
            {testFailure && <FailureNotice title={testFailure.title} message={testFailure.message} />}
          </div>
        </div>
      </Card>

      <Card>
        <fieldset>
          <legend className="text-base font-semibold tracking-tight">
            {isMongo ? "Databases" : "Schemas"}
          </legend>
          <CardDescription>
            {isMongo
              ? "Choose the databases Manifest may document and query. MongoDB's own admin, local, and config databases are never listed."
              : "Choose the schemas Manifest may document and query. System schemas are never listed."}
          </CardDescription>

          <div className="mt-4 space-y-3">
            {!connection && !testIsCurrent && (
              <p className="text-sm text-(--muted)">
                {tested
                  ? `The connection settings changed. Test again to refresh the ${terms.schema} list.`
                  : `Test the connection to see the ${terms.schemas} you can read.`}
              </p>
            )}
            {connection && !testIsCurrent && (
              <>
                {liveSchemas.isPending && (
                  <LoadingState label={`Reading ${terms.schemas} from the server…`} />
                )}
                {liveSchemas.isError && (
                  <FailureNotice
                    title={`Could not list ${terms.schemas} with the saved settings`}
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
            {testIsCurrent && tested.result.schemaListLimited && (
              <p className="text-sm text-(--muted)">
                This user may not list databases, so only the database from the settings is offered.
              </p>
            )}
            {showSchemaList && available !== null && options.length === 0 && (
              <p className="text-sm text-(--muted)">
                {isMongo
                  ? "This user cannot read any databases on that server. Grant it read access to a database, or name one in the settings, then test again."
                  : "This user cannot read any schemas in that database. Grant USAGE on a schema, then test again."}
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
