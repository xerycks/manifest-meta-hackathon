import { z } from "zod"

import { connectionParamsSchema } from "./schemas.js"

export const columnParamsSchema = connectionParamsSchema.extend({ columnId: z.uuid() })
export const relationshipParamsSchema = connectionParamsSchema.extend({ relationshipId: z.uuid() })

/** The version the editor loaded; a stale one is rejected with the current record. */
const versionSchema = z.number().int().min(1).max(2_147_483_647)

/** A one-line or short plain-text field: trimmed, and empty clears it. */
function plainField(label: string, max: number) {
  return z
    .string()
    .max(max, `The ${label} can be at most ${max} characters`)
    .transform((value) => value.trim() || null)
    .nullable()
    .optional()
}

/** Markdown keeps its formatting as written; whitespace-only clears it. */
function markdownField(label: string, max: number) {
  return z
    .string()
    .max(max, `The ${label} can be at most ${max.toLocaleString("en-US")} characters`)
    .transform((value) => (value.trim() ? value.trimEnd() : null))
    .nullable()
    .optional()
}

const changesSomething = (input: Record<string, unknown>) =>
  Object.entries(input).some(([key, value]) => key !== "version" && value !== undefined)
const CHANGE_REQUIRED = "Change at least one field"

export const objectPatchSchema = z
  .strictObject({
    version: versionSchema,
    label: plainField("label", 200),
    description: markdownField("description", 20_000),
    rowMeaning: plainField("row meaning", 500),
  })
  .refine(changesSomething, CHANGE_REQUIRED)

export const columnPatchSchema = z
  .strictObject({
    version: versionSchema,
    label: plainField("label", 200),
    description: markdownField("description", 20_000),
    unit: plainField("unit", 100),
    valueNotes: plainField("value notes", 2_000),
  })
  .refine(changesSomething, CHANGE_REQUIRED)

const remarkField = plainField("remark", 1_000)

export const createRelationshipSchema = z.strictObject({
  fromColumnId: z.uuid("Choose the column that holds the reference"),
  toColumnId: z.uuid("Choose the column it refers to"),
  remark: remarkField,
})

export const updateRelationshipSchema = z
  .strictObject({
    version: versionSchema,
    fromColumnId: z.uuid().optional(),
    toColumnId: z.uuid().optional(),
    remark: remarkField,
  })
  .refine(changesSomething, CHANGE_REQUIRED)
  .refine((input) => (input.fromColumnId === undefined) === (input.toColumnId === undefined), {
    message: "Choose both columns when changing a relationship",
    path: ["toColumnId"],
  })

export type ObjectPatch = z.infer<typeof objectPatchSchema>
export type ColumnPatch = z.infer<typeof columnPatchSchema>
export type CreateRelationshipInput = z.infer<typeof createRelationshipSchema>
export type UpdateRelationshipInput = z.infer<typeof updateRelationshipSchema>

const TYPE_FAMILIES: [family: string, pattern: RegExp][] = [
  [
    "number",
    /^(smallint|integer|bigint|int[248]?|numeric|decimal|real|double precision|float[48]?|money|oid)\b/,
  ],
  ["text", /^(text|character varying|varchar|character|char|bpchar|citext|name)\b/],
  ["timestamp", /^(timestamp|date)\b/],
  ["time", /^time\b/],
  ["json", /^jsonb?\b/],
]

/**
 * A coarse family for a PostgreSQL type as discovery formats it (modifiers
 * like varchar(80) and numeric(12,2) ignored). Enums compare as text; arrays
 * only match arrays of the same family.
 */
export function typeFamily(column: { dataType: string; enumValues: string[] | null }): string {
  const type = column.dataType.trim().toLowerCase()
  const array = type.endsWith("[]")
  const base = array ? type.slice(0, -2) : type
  const family =
    column.enumValues !== null
      ? "text"
      : (TYPE_FAMILIES.find(([, pattern]) => pattern.test(base))?.[0] ??
        base.replace(/\(.*\)/, "").trim())
  return array ? `${family}[]` : family
}

/** Whether values of the two columns could plausibly be joined on. */
export function typesCompatible(
  a: { dataType: string; enumValues: string[] | null },
  b: { dataType: string; enumValues: string[] | null },
): boolean {
  return typeFamily(a) === typeFamily(b)
}
