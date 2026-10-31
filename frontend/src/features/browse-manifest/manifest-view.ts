import type {
  ManifestObjectKind,
  ManifestRelationship,
  MongoCollectionDetails,
  MongoFieldDetails,
  TypeCount,
} from "../../entities/manifests/types.ts"
import { ApiError } from "../../shared/api/client.ts"

export const KIND_LABELS: Record<ManifestObjectKind, string> = {
  table: "Table",
  view: "View",
  materialized_view: "Materialized view",
  partitioned_table: "Partitioned table",
  foreign_table: "Foreign table",
  collection: "Collection",
}

/** An estimate (the planner's, or MongoDB's document count), so it is labelled as approximate. */
export function formatRowEstimate(
  rows: number | null,
  noun: { one: string; many: string } = { one: "row", many: "rows" },
): string | null {
  if (rows === null) return null
  return `≈ ${rows.toLocaleString("en-US")} ${rows === 1 ? noun.one : noun.many}`
}

/** A share of the sample that never rounds a few documents away to 0% or all of them up to 100%. */
export function formatShare(documents: number, sampleSize: number): string {
  if (sampleSize <= 0) return "0%"
  const percent = (documents / sampleSize) * 100
  if (documents > 0 && percent < 1) return "<1%"
  if (documents < sampleSize && percent > 99) return ">99%"
  return `${Math.round(percent)}%`
}

export interface PresencePart {
  label: string
  share: string
  /** Missing documents and nulls are worth a second look. */
  tone: "neutral" | "warning"
}

/** Every type seen, then how often the field was missing: "string 92%, null 3%, missing 5%". */
export function presenceParts(details: MongoFieldDetails): PresencePart[] {
  const parts: PresencePart[] = details.types.map((entry) => ({
    label: entry.type,
    share: formatShare(entry.documents, details.sampleSize),
    tone: entry.type === "null" || entry.type === "undefined" ? "warning" : "neutral",
  }))
  if (details.missing > 0) {
    parts.push({ label: "missing", share: formatShare(details.missing, details.sampleSize), tone: "warning" })
  }
  return parts
}

export function presenceSummary(details: MongoFieldDetails): string {
  return presenceParts(details)
    .map((part) => `${part.label} ${part.share}`)
    .join(", ")
}

/** True when the field held more than one kind of value (nulls aside). */
export function hasMixedTypes(details: MongoFieldDetails): boolean {
  return details.types.filter((entry) => entry.type !== "null" && entry.type !== "undefined").length > 1
}

export function formatElementTypes(types: TypeCount[]): string {
  return types.map((entry) => entry.type).join(", ")
}

/** "Fields from a random sample of 200 documents", plus anything that limited it. */
export function describeSample(details: MongoCollectionDetails): { summary: string; notes: string[] } {
  const documents = `${details.sampleSize.toLocaleString("en-US")} ${details.sampleSize === 1 ? "document" : "documents"}`
  const summary =
    details.sampleMethod === "random"
      ? `Fields inferred from a random sample of ${documents}.`
      : `Fields inferred from the first ${documents} (random sampling is not available here).`
  const notes: string[] = []
  if (details.sampleBytesLimited) notes.push("Sampling stopped early because the documents are large.")
  if (details.fieldsTruncated) notes.push("Only the first 500 fields are listed.")
  if (details.depthTruncated) notes.push("Fields nested more than 6 levels deep are not listed.")
  return { summary, notes }
}

/** A dotted field path split into its parent prefix and its own name, for indented display. */
export function splitFieldPath(path: string, depth: number): { parent: string; leaf: string } {
  if (depth <= 0) return { parent: "", leaf: path }
  const parts = path.split(".")
  const leaf = parts.slice(depth).join(".")
  return { parent: `${parts.slice(0, depth).join(".")}.`, leaf }
}

export interface ColumnReference {
  objectId: string
  schema: string
  name: string
  /** The referenced column for this one. */
  column: string
  present: boolean
}

/** For each column of an object, the columns its foreign keys point at. */
export function columnReferences(outgoing: ManifestRelationship[]): Map<string, ColumnReference[]> {
  const references = new Map<string, ColumnReference[]>()
  for (const relationship of outgoing) {
    if (!relationship.present) continue
    relationship.from.columns.forEach((column, index) => {
      const target = relationship.to.columns[index]
      if (target === undefined) return
      const list = references.get(column) ?? []
      list.push({
        objectId: relationship.to.objectId,
        schema: relationship.to.schema,
        name: relationship.to.name,
        column: target,
        present: relationship.to.present,
      })
      references.set(column, list)
    })
  }
  return references
}

/** Malformed ids fail validation; either way the item does not exist here. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 422)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again."
}
