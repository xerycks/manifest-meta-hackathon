import type {
  ManifestColumn,
  ManifestRelationship,
  UpdateRelationshipInput,
} from "../../entities/manifests/types.ts"
import { changedKeys, theirChanges, type DraftFields, type DraftState } from "../../shared/lib/draft.ts"
import type { ConflictField } from "../../shared/ui/conflict-notice.tsx"

export interface FieldDef<K extends string> {
  key: K
  label: string
  max: number
  /** line: one line; text: plain multi-line text; markdown: Write/Preview editor. */
  kind: "line" | "text" | "markdown"
  hint?: string
  placeholder?: string
}

export const OBJECT_FIELDS = [
  { key: "label", label: "Label", max: 200, kind: "line", placeholder: "Business name, e.g. Orders" },
  {
    key: "rowMeaning",
    label: "Each row is",
    max: 500,
    kind: "line",
    placeholder: "e.g. one row per order line",
  },
  {
    key: "description",
    label: "Description",
    max: 20_000,
    kind: "markdown",
    placeholder: "What this table holds, how it is filled, and what to watch out for…",
  },
] as const satisfies readonly FieldDef<string>[]

export type ObjectField = (typeof OBJECT_FIELDS)[number]["key"]
export const OBJECT_KEYS = OBJECT_FIELDS.map((field) => field.key)

export const COLUMN_FIELDS = [
  { key: "label", label: "Label", max: 200, kind: "line", placeholder: "Business name, e.g. Order total" },
  { key: "unit", label: "Unit", max: 100, kind: "line", placeholder: "e.g. USD, days, kg" },
  {
    key: "description",
    label: "Description",
    max: 20_000,
    kind: "markdown",
    placeholder: "What the value means and how it is calculated…",
  },
  {
    key: "valueNotes",
    label: "Allowed or example values",
    max: 2_000,
    kind: "text",
    placeholder: "e.g. pending, paid, refunded — or ISO country codes such as US, DE",
  },
] as const satisfies readonly FieldDef<string>[]

export type ColumnField = (typeof COLUMN_FIELDS)[number]["key"]
export const COLUMN_KEYS = COLUMN_FIELDS.map((field) => field.key)

/** The fields someone else changed, with their saved values, for the conflict notice. */
export function conflictFields<K extends string>(
  state: DraftState<K>,
  fields: readonly FieldDef<K>[],
): ConflictField[] {
  const theirs = state.conflict?.fields
  if (!theirs) return []
  const changed = new Set(theirChanges(state))
  return fields
    .filter((field) => changed.has(field.key))
    .map((field) => ({ label: field.label, value: theirs[field.key], markdown: field.kind === "markdown" }))
}

export function hasColumnMeaning(column: ManifestColumn): boolean {
  return Boolean(column.label || column.description || column.unit || column.valueNotes)
}

// Relationships ---------------------------------------------------------------

export type RelationshipField = "fromColumn" | "toObjectId" | "toColumn" | "remark"

export const EMPTY_RELATIONSHIP: DraftFields<RelationshipField> = {
  fromColumn: "",
  toObjectId: "",
  toColumn: "",
  remark: "",
}

/** A relationship as the form edits it: column names (single-column ends) and a remark. */
export function relationshipFields(relationship: ManifestRelationship): DraftFields<RelationshipField> {
  return {
    fromColumn: relationship.from.columns.join(", "),
    toObjectId: relationship.to.objectId,
    toColumn: relationship.to.columns.join(", "),
    remark: relationship.remark ?? "",
  }
}

const columnId = (columns: { id: string; name: string }[], name: string) =>
  columns.find((column) => column.name === name)?.id

/**
 * The PATCH for an edited relationship: the remark when it changed, and both
 * column ids when either end changed. Null while a chosen column cannot be
 * resolved (its object's columns are still loading).
 */
export function relationshipPatch(
  state: DraftState<RelationshipField>,
  fromColumns: { id: string; name: string }[],
  toColumns: { id: string; name: string }[],
): UpdateRelationshipInput | null {
  const changed = changedKeys(state.base, state.draft)
  const patch: UpdateRelationshipInput = { version: state.version }
  if (changed.includes("remark")) patch.remark = state.draft.remark.trim() || null
  if (changed.some((key) => key !== "remark")) {
    const fromColumnId = columnId(fromColumns, state.draft.fromColumn)
    const toColumnId = columnId(toColumns, state.draft.toColumn)
    if (!fromColumnId || !toColumnId) return null
    patch.fromColumnId = fromColumnId
    patch.toColumnId = toColumnId
  }
  return patch
}

/** Ids for a new relationship, or null until both columns are chosen and known. */
export function newRelationship(
  draft: DraftFields<RelationshipField>,
  fromColumns: { id: string; name: string }[],
  toColumns: { id: string; name: string }[],
): { fromColumnId: string; toColumnId: string; remark: string | null } | null {
  const fromColumnId = columnId(fromColumns, draft.fromColumn)
  const toColumnId = columnId(toColumns, draft.toColumn)
  if (!fromColumnId || !toColumnId) return null
  return { fromColumnId, toColumnId, remark: draft.remark.trim() || null }
}
