import { ArrowRight, Plus } from "lucide-react"
import { useState } from "react"

import { useDeleteRelationship } from "@/entities/manifests/api.ts"
import { ObjectLink } from "@/entities/manifests/ObjectLink.tsx"
import type { ManifestObjectDetail, ManifestRelationship } from "@/entities/manifests/types.ts"
import { cn } from "@/shared/lib/cn.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"
import { Badge } from "@/shared/ui/badge.tsx"
import { Button } from "@/shared/ui/button.tsx"
import { FailureNotice } from "@/shared/ui/failure-notice.tsx"

import { RelationshipForm } from "./RelationshipForm.tsx"

const smallButton = "px-2 py-0.5 text-xs"

/** "orders.customer_id to shop.customers.id", for the labels of per-relationship buttons. */
function describe(relationship: ManifestRelationship): string {
  const { from, to } = relationship
  return `${from.name}.${from.columns.join(", ")} to ${to.schema}.${to.name}.${to.columns.join(", ")}`
}

function RemoveRelationship({
  workspaceId,
  connectionId,
  relationship,
}: {
  workspaceId: string
  connectionId: string
  relationship: ManifestRelationship
}) {
  const [confirming, setConfirming] = useState(false)
  const remove = useDeleteRelationship(workspaceId, connectionId)
  if (!confirming) {
    return (
      <Button
        variant="ghost"
        className={smallButton}
        aria-label={`Remove relationship ${describe(relationship)}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
    )
  }
  return (
    <div role="group" aria-label="Confirm removal" className="mt-1 w-full space-y-2">
      <p className="text-sm">Remove this relationship? Its remark is removed with it.</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="danger"
          className={smallButton}
          disabled={remove.isPending}
          autoFocus
          onClick={() => remove.mutate(relationship.id)}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
        <Button
          variant="secondary"
          className={smallButton}
          disabled={remove.isPending}
          onClick={() => setConfirming(false)}
        >
          Keep
        </Button>
      </div>
      {remove.error && <FailureNotice title="Not removed" message={apiErrorMessage(remove.error)} />}
    </div>
  )
}

function RelationshipList({
  title,
  empty,
  relationships,
  direction,
  workspaceId,
  connectionId,
  mongo,
  canEdit,
  onEdit,
}: {
  title: string
  empty: string
  relationships: ManifestRelationship[]
  direction: "outgoing" | "incoming"
  workspaceId: string
  connectionId: string
  /** MongoDB sources have collections and fields. */
  mongo: boolean
  canEdit: boolean
  onEdit: (relationship: ManifestRelationship) => void
}) {
  return (
    <section>
      <h4 className="text-sm font-semibold">{title}</h4>
      {relationships.length === 0 ? (
        <p className="mt-1 text-sm text-(--muted)">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-3 text-sm">
          {relationships.map((relationship) => {
            const manual = relationship.origin === "manual"
            return (
              <li key={relationship.id} className={cn(!relationship.present && "text-(--muted)")}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {direction === "outgoing" ? (
                    <>
                      <code>{relationship.from.columns.join(", ")}</code>
                      <ArrowRight aria-label="refers to" className="size-3.5 text-(--muted)" />
                      <ObjectLink connectionId={connectionId} end={relationship.to} />
                      <code>({relationship.to.columns.join(", ")})</code>
                    </>
                  ) : (
                    <>
                      <ObjectLink connectionId={connectionId} end={relationship.from} />
                      <code>({relationship.from.columns.join(", ")})</code>
                      <ArrowRight aria-label="refers to" className="size-3.5 text-(--muted)" />
                      <code>{relationship.to.columns.join(", ")}</code>
                    </>
                  )}
                  {manual && <Badge>Manual</Badge>}
                  {!relationship.present && <Badge>Removed</Badge>}
                  {relationship.needsReview && <Badge tone="danger">Needs review</Badge>}
                </div>
                {relationship.remark && (
                  <p className="mt-1 leading-6 break-words whitespace-pre-wrap text-(--muted)">
                    {relationship.remark}
                  </p>
                )}
                {relationship.needsReview && (
                  <p className="mt-1 text-xs leading-5 text-(--danger)">
                    {mongo
                      ? "A collection or field it uses was not found by the latest refresh."
                      : "A table or column it uses is no longer in the source."}
                    {canEdit && ` Choose other ${mongo ? "fields" : "columns"} or remove it.`}
                  </p>
                )}
                {canEdit && (
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <Button
                      variant="ghost"
                      className={cn("-ml-2", smallButton)}
                      aria-label={`${manual ? "Edit relationship" : "Remark on foreign key"} ${describe(relationship)}`}
                      onClick={() => onEdit(relationship)}
                    >
                      {manual ? "Edit" : relationship.remark ? "Edit remark" : "Add remark"}
                    </Button>
                    {manual && (
                      <RemoveRelationship
                        workspaceId={workspaceId}
                        connectionId={connectionId}
                        relationship={relationship}
                      />
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

type ActiveForm = { relationship: ManifestRelationship | null } | null

/**
 * Discovered foreign keys and manual relationships of one object. Owners and
 * admins add manual relationships, move or remove them, and remark on any.
 */
export function RelationshipsSection({
  workspaceId,
  connectionId,
  detail,
  canEdit,
}: {
  workspaceId: string
  connectionId: string
  detail: ManifestObjectDetail
  canEdit: boolean
}) {
  const [form, setForm] = useState<ActiveForm>(null)
  const listProps = {
    workspaceId,
    connectionId,
    mongo: detail.object.details?.engine === "mongodb",
    // One form at a time, so opening another never drops a draft.
    canEdit: canEdit && form === null,
    onEdit: (relationship: ManifestRelationship) => setForm({ relationship }),
  }

  return (
    <section aria-labelledby={`relationships-${detail.object.id}`} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`relationships-${detail.object.id}`} className="text-sm font-semibold">
          Relationships
        </h3>
        {canEdit && detail.object.present && form === null && (
          <Button
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            onClick={() => setForm({ relationship: null })}
          >
            <Plus aria-hidden className="size-3.5" />
            Add relationship
          </Button>
        )}
      </div>
      {form && (
        <RelationshipForm
          key={form.relationship?.id ?? "new"}
          workspaceId={workspaceId}
          connectionId={connectionId}
          object={detail.object}
          relationship={form.relationship}
          onClose={() => setForm(null)}
        />
      )}
      <div className="grid gap-6 md:grid-cols-2">
        <RelationshipList
          title="References"
          empty="Nothing from this object refers to another one."
          relationships={detail.outgoing}
          direction="outgoing"
          {...listProps}
        />
        <RelationshipList
          title="Referenced by"
          empty="Nothing refers to this object."
          relationships={detail.incoming}
          direction="incoming"
          {...listProps}
        />
      </div>
    </section>
  )
}
