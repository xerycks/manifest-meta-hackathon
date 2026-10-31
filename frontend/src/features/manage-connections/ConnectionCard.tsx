import { BookOpenText, Pencil, RefreshCw, Trash2 } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { Link } from "react-router-dom"

import { useDeleteConnection, useRetestConnection } from "@/entities/connections/api.ts"
import { describeEndpoint, ENGINE_LABELS } from "@/entities/connections/engine.ts"
import { EngineIcon } from "@/entities/connections/EngineIcon.tsx"
import type { Connection } from "@/entities/connections/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { formatRelativeTime } from "@/shared/lib/relative-time.ts"
import { Button, buttonVariants } from "@/shared/ui/button.tsx"
import { Card } from "@/shared/ui/card.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { describeConnectionError, SSL_MODE_OPTIONS } from "./connection-form.ts"
import { ConnectionStatusBadge } from "./ConnectionStatusBadge.tsx"

/** How the connection is protected in transit, in words. */
function securityOf(connection: Connection): string {
  if (connection.engine === "postgres") {
    return SSL_MODE_OPTIONS.find((option) => option.value === connection.config.sslMode)?.label ?? ""
  }
  if (connection.config.mode === "uri") return "As set in the connection string"
  return connection.config.tls ? "TLS, certificate verified" : "No TLS — local or private networks only"
}

function credentialsOf(connection: Connection): string {
  if (connection.engine === "mongodb" && connection.config.mode === "uri") {
    return "Connection string saved, encrypted"
  }
  return connection.hasPassword ? "Saved, encrypted" : "None"
}

/** A saved source: settings, status, and (for owners and admins) retest, edit, and remove. */
export function ConnectionCard({
  connection,
  workspaceId,
  canManage,
  onRemoved,
}: {
  connection: Connection
  workspaceId: string
  canManage: boolean
  /** Called after removal, once this card has left the list, so the page can move focus. */
  onRemoved?: (connection: Connection) => void
}) {
  const retest = useRetestConnection(workspaceId)
  const remove = useDeleteConnection(workspaceId)
  const [confirming, setConfirming] = useState(false)
  const removeTrigger = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  const confirmTitleId = useId()

  useEffect(() => {
    // Move focus into the confirmation, and back to its trigger when it closes.
    if (confirming) cancelButton.current?.focus()
    else if (wasConfirming.current) removeTrigger.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  const engineLabel = ENGINE_LABELS[connection.engine]
  const isMongo = connection.engine === "mongodb"
  const failure = retest.isError
    ? describeConnectionError(retest.error)
    : connection.status === "failed" && connection.lastError
      ? { title: "Last test failed", message: connection.lastError }
      : null

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight break-words">{connection.name}</h2>
          <p className="mt-0.5 flex items-start gap-1.5 text-sm text-(--muted)">
            <EngineIcon engine={connection.engine} className="mt-0.5" />
            <span className="min-w-0 break-all">
              {engineLabel} · {describeEndpoint(connection)}
            </span>
          </p>
        </div>
        <ConnectionStatusBadge status={connection.status} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt className="text-(--muted)">{isMongo ? "Databases" : "Schemas"}</dt>
        <dd className="break-words">{connection.schemas.join(", ")}</dd>
        <dt className="text-(--muted)">{isMongo ? "TLS" : "SSL"}</dt>
        <dd>{securityOf(connection)}</dd>
        <dt className="text-(--muted)">Credentials</dt>
        <dd>{credentialsOf(connection)}</dd>
        <dt className="text-(--muted)">Analysis</dt>
        <dd>
          {connection.capabilities.queryLanguage === "sql"
            ? "Read-only SQL queries"
            : "Read-only find and aggregate (no SQL)"}
        </dd>
        <dt className="text-(--muted)">Last tested</dt>
        <dd>
          {connection.lastTestedAt ? (
            <time
              dateTime={connection.lastTestedAt}
              title={new Date(connection.lastTestedAt).toLocaleString()}
            >
              {formatRelativeTime(connection.lastTestedAt)}
            </time>
          ) : (
            "Never"
          )}
        </dd>
      </dl>

      {retest.isSuccess && (
        <p role="status" className="text-sm text-(--success)">
          Connected in {retest.data.test.latencyMs} ms · {engineLabel} {retest.data.test.serverVersion}
        </p>
      )}
      {failure && <FailureNotice title={failure.title} message={failure.message} />}

      {!confirming && (
        <div className="flex flex-wrap gap-2">
          <Link to={`/manifests/${connection.id}`} className={buttonVariants({ variant: "secondary" })}>
            <BookOpenText aria-hidden className="size-4" />
            Browse metadata
          </Link>
          {canManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => retest.mutate(connection.id)}
                disabled={retest.isPending}
              >
                <RefreshCw
                  aria-hidden
                  className={cn("size-4", retest.isPending && "animate-spin motion-reduce:animate-none")}
                />
                {retest.isPending ? "Testing…" : "Retest"}
              </Button>
              <Link to={`/sources/${connection.id}`} className={buttonVariants({ variant: "secondary" })}>
                <Pencil aria-hidden className="size-4" />
                Edit
              </Link>
              <Button ref={removeTrigger} variant="ghost" onClick={() => setConfirming(true)}>
                <Trash2 aria-hidden className="size-4" />
                Remove
              </Button>
            </>
          )}
        </div>
      )}

      {canManage && confirming && (
        <div
          role="group"
          aria-labelledby={confirmTitleId}
          className="rounded-md border border-(--danger-border) bg-(--danger-surface) p-4"
        >
          <p id={confirmTitleId} className="text-sm font-medium text-(--danger)">
            Remove “{connection.name}”?
          </p>
          <p className="mt-1 text-sm leading-6 text-(--danger)">
            Manifest deletes its saved settings and encrypted credentials. The database itself is not
            changed.
          </p>
          {remove.isError && (
            <p role="alert" className="mt-2 text-sm font-medium text-(--danger)">
              {describeConnectionError(remove.error).message}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="danger"
              onClick={() => {
                // mutate() callbacks skip unmounted cards; failures show through remove.error.
                remove.mutateAsync(connection.id).then(() => onRemoved?.(connection), () => {})
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Removing…" : "Remove source"}
            </Button>
            <Button
              ref={cancelButton}
              variant="secondary"
              onClick={() => {
                remove.reset()
                setConfirming(false)
              }}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
