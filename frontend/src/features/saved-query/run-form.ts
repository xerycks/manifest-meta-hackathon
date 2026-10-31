import type { ParameterDefinition, RunValues } from "../../entities/saved-queries/types.ts"

/** One parameter before a run: its default, or a date chosen for this run. */
export interface RunField {
  mode: "default" | "value"
  /** "2026-10-01" (date input) or "2026-10-01T09:30" (date and time input); "" for none. */
  value: string
}

export type RunForm = Record<string, RunField>

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/

/** Parameters with a default start on it; the others start empty. */
export function initialRunForm(definitions: ParameterDefinition[]): RunForm {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.name,
      { mode: definition.default ? "default" : "value", value: "" } satisfies RunField,
    ]),
  )
}

/**
 * The values to send: defaults are left out (the server resolves them at run
 * time), chosen dates are sent as typed, and an optional parameter left empty
 * is sent as null. Required ones without a value are reported by name.
 */
export function runValues(
  definitions: ParameterDefinition[],
  form: RunForm,
): { values: RunValues } | { errors: Record<string, string> } {
  const values: RunValues = {}
  const errors: Record<string, string> = {}
  for (const definition of definitions) {
    const field = form[definition.name] ?? { mode: definition.default ? "default" : "value", value: "" }
    if (field.mode === "default" && definition.default) continue
    const value = field.value.trim()
    if (!value) {
      if (definition.required) {
        errors[definition.name] = definition.type === "date" ? "Choose a date." : "Choose a date and time."
      } else {
        values[definition.name] = null
      }
      continue
    }
    if (!(definition.type === "date" ? DATE : DATETIME).test(value)) {
      errors[definition.name] =
        definition.type === "date"
          ? "Use a date like 2026-10-01."
          : "Use a date and time like 2026-10-01T09:30."
      continue
    }
    values[definition.name] = value
  }
  return Object.keys(errors).length > 0 ? { errors } : { values }
}
