import assert from "node:assert/strict"
import test from "node:test"

import type { EvidenceItem } from "../src/entities/agent/types.ts"
import { csvExportHref, csvFileName } from "../src/entities/queries/export.ts"
import {
  canChangeSavedQuery,
  describeParameterValue,
  describeResolved,
  formatParameterValue,
  relativeLabel,
} from "../src/entities/saved-queries/parameters.ts"
import type { ParameterDefinition } from "../src/entities/saved-queries/types.ts"
import { initialRunForm, runValues } from "../src/features/saved-query/run-form.ts"
import {
  createInput,
  newParameter,
  parameterDefinitions,
  parameterDraft,
  parametersSummary,
  parametersText,
  prefillFromEvidence,
  prefillFromQuery,
  queryFromText,
  savedQueryFields,
  updatePatch,
  type ParameterDraft,
} from "../src/features/saved-query/saved-query-form.ts"
import { startDraft } from "../src/shared/lib/draft.ts"

const since: ParameterDefinition = {
  name: "since",
  label: "Since",
  type: "date",
  default: { kind: "relative", value: "start_of_month" },
  required: true,
}
const until: ParameterDefinition = {
  name: "until",
  label: "Until",
  type: "datetime",
  default: null,
  required: true,
}
const region: ParameterDefinition = { name: "day", label: "day", type: "date", default: null, required: false }

const evidence: EvidenceItem = {
  executionId: "0b9d0c55-7a42-4c55-9f3e-0f5a2f3c4b11",
  connectionId: "3f6a1f3e-8f1d-4c3a-9a5b-2d4c6e8f0a12",
  label: "  Monthly net revenue  ",
  query: {
    language: "sql",
    sql: "SELECT date_trunc('month', ordered_at) AS month, sum(total) FROM orders GROUP BY 1",
  },
  columns: [],
  rows: [],
  rowCount: 18,
  truncated: false,
}

test("relative dates read as plain words", () => {
  assert.equal(relativeLabel("today"), "Today")
  assert.equal(relativeLabel("yesterday"), "Yesterday")
  assert.equal(relativeLabel("start_of_week"), "Start of this week (Monday)")
  assert.equal(relativeLabel("start_of_month"), "Start of this month")
  assert.equal(relativeLabel("start_of_quarter"), "Start of this quarter")
  assert.equal(relativeLabel("start_of_year"), "Start of this year")
  assert.equal(relativeLabel("days_ago:1"), "1 day ago")
  assert.equal(relativeLabel("days_ago:30"), "30 days ago")
  assert.equal(relativeLabel("days_ago:0"), "Today")
  assert.equal(relativeLabel("months_ago:1"), "1 month ago")
  assert.equal(relativeLabel("months_ago:1200"), "1,200 months ago")
  assert.equal(relativeLabel("fortnight_ago"), "fortnight_ago")

  assert.equal(describeParameterValue(null), "No default")
  assert.equal(describeParameterValue({ kind: "relative", value: "days_ago:7" }), "7 days ago")
  assert.equal(describeParameterValue({ kind: "absolute", value: "2026-10-01T09:30" }), "2026-10-01 09:30")
  assert.equal(formatParameterValue("2026-10-01T00:00:00+05:30"), "2026-10-01 00:00:00+05:30")
  assert.equal(
    describeResolved({
      name: "since",
      label: "Since",
      type: "date",
      from: "default",
      input: { kind: "relative", value: "start_of_month" },
      value: "2026-10-01",
    }),
    "Start of this month (2026-10-01)",
  )
  const fixed = { name: "d", label: "d", type: "date" as const, from: "run" as const }
  assert.equal(
    describeResolved({ ...fixed, input: { kind: "absolute", value: "2026-01-02" }, value: "2026-01-02" }),
    "2026-01-02",
  )
  assert.equal(describeResolved({ ...fixed, from: null, input: null, value: null }), "No value")
})

test("the run form sends chosen dates, leaves defaults to the server, and names what is missing", () => {
  const definitions = [since, until, region]
  const form = initialRunForm(definitions)
  assert.deepEqual(form, {
    since: { mode: "default", value: "" },
    until: { mode: "value", value: "" },
    day: { mode: "value", value: "" },
  })
  assert.deepEqual(runValues(definitions, form), { errors: { until: "Choose a date and time." } })

  const filled = { ...form, until: { mode: "value" as const, value: "2026-11-01T09:30" } }
  // Defaults are resolved by the server at run time; an empty optional parameter is sent as null.
  assert.deepEqual(runValues(definitions, filled), { values: { until: "2026-11-01T09:30", day: null } })

  const overridden = {
    ...filled,
    since: { mode: "value" as const, value: "2026-09-15" },
    day: { mode: "value" as const, value: "2026-09-20" },
  }
  assert.deepEqual(runValues(definitions, overridden), {
    values: { since: "2026-09-15", until: "2026-11-01T09:30", day: "2026-09-20" },
  })
  // Choosing "another date" without one is not a silent fallback to the default.
  assert.deepEqual(runValues(definitions, { ...filled, since: { mode: "value", value: "" } }), {
    errors: { since: "Choose a date." },
  })
  assert.deepEqual(runValues(definitions, { ...filled, day: { mode: "value", value: "20/09/2026" } }), {
    errors: { day: "Use a date like 2026-10-01." },
  })
  assert.deepEqual(runValues([], {}), { values: {} })
})

test("CSV file names say what, when, and whether the file is partial", () => {
  const at = "2026-10-31T09:30:00.000Z"
  assert.equal(csvFileName("Monthly net revenue", at, false), "monthly-net-revenue-2026-10-31.csv")
  assert.equal(csvFileName("Monthly net revenue", at, true), "monthly-net-revenue-2026-10-31-partial.csv")
  assert.equal(csvFileName("  Orders / refunds (Q3)! ", at, false), "orders-refunds-q3-2026-10-31.csv")
  assert.equal(csvFileName("Umsatz pro Monat €", at, false), "umsatz-pro-monat-2026-10-31.csv")
  assert.equal(csvFileName("???", at, false), "query-2026-10-31.csv")
  assert.equal(csvFileName("a".repeat(100), at, false), `${"a".repeat(60)}-2026-10-31.csv`)
  assert.equal(
    csvExportHref("ws 1", "conn", "exec"),
    "/api/v1/workspaces/ws%201/connections/conn/queries/exec/export.csv",
  )
})

test("Save as query from evidence starts with its label, source, query, and the answer it came from", () => {
  const prefill = prefillFromEvidence(evidence, "run-1")
  assert.deepEqual(prefill, {
    connectionId: evidence.connectionId,
    fields: {
      name: "Monthly net revenue",
      description: "",
      query: evidence.query.language === "sql" ? evidence.query.sql : "",
      parameters: "[]",
      visibility: "workspace",
    },
    origin: { runId: "run-1", executionId: evidence.executionId },
  })
  assert.deepEqual(createInput(prefill.fields, prefill, "postgres"), {
    input: {
      name: "Monthly net revenue",
      description: "",
      query: evidence.query,
      parameters: [],
      visibility: "workspace",
      connectionId: evidence.connectionId,
      origin: { runId: "run-1", executionId: evidence.executionId },
    },
  })

  // MongoDB queries are edited as the JSON people read, and come back as the same query.
  const mongo = prefillFromEvidence(
    {
      ...evidence,
      label: "x".repeat(250),
      query: {
        language: "mongodb",
        database: "manifest_demo",
        collection: "sessions",
        operation: "aggregate",
        pipeline: [{ $match: { device: "mobile" } }],
      },
    },
    "run-2",
  )
  assert.equal(mongo.fields.name.length, 200)
  assert.match(mongo.fields.query, /"collection": "sessions"/)
  assert.ok(!mongo.fields.query.includes("language"))
  const built = createInput(mongo.fields, mongo, "mongodb")
  assert.ok("input" in built)
  assert.deepEqual(built.input.query, {
    language: "mongodb",
    database: "manifest_demo",
    collection: "sessions",
    operation: "aggregate",
    pipeline: [{ $match: { device: "mobile" } }],
  })

  // The console's query, to be named; an empty console still opens the editor.
  assert.equal(prefillFromQuery({ language: "sql", sql: "SELECT 1" }, "c").fields.query, "SELECT 1")
  assert.equal(prefillFromQuery(null, "c").fields.query, "")
  const empty = prefillFromQuery(null, "c")
  assert.deepEqual(createInput(empty.fields, empty, "postgres"), {
    errors: { name: "Give the saved query a name.", query: "Enter a SELECT statement." },
  })
  assert.match((queryFromText("[1]", "mongodb") as { error: string }).error, /JSON object/)
  assert.match((queryFromText("{", "mongodb") as { error: string }).error, /not valid JSON/)
})

test("parameter rows become definitions, with a problem named per row", () => {
  const drafts: ParameterDraft[] = [
    { ...newParameter([]), label: "Since", defaultChoice: "start_of_month" },
    {
      ...newParameter([]),
      name: "until",
      type: "datetime",
      defaultChoice: "absolute",
      absolute: "2026-11-01T09:30",
    },
    { ...newParameter([]), name: "back", defaultChoice: "days_ago", count: "30", required: false },
  ]
  assert.deepEqual(parameterDefinitions(drafts), {
    definitions: [
      { ...since, label: "Since" },
      { ...until, label: "until", default: { kind: "absolute", value: "2026-11-01T09:30" } },
      {
        name: "back",
        label: "back",
        type: "date",
        default: { kind: "relative", value: "days_ago:30" },
        required: false,
      },
    ],
  })
  const problems = parameterDefinitions([
    { ...newParameter([]), name: "1st" },
    { ...newParameter([]), name: "x" },
    { ...newParameter([]), name: "X" },
    { ...newParameter([]), name: "y", defaultChoice: "months_ago", count: "1201" },
    { ...newParameter([]), name: "z", defaultChoice: "absolute", absolute: "" },
    { ...newParameter([]), name: "w", type: "datetime", defaultChoice: "absolute", absolute: "2026-11-01 9am" },
  ])
  assert.ok("errors" in problems)
  assert.deepEqual(Object.keys(problems.errors), ["0", "2", "3", "4", "5"])
  assert.match(problems.errors[2] ?? "", /already named X/)
  assert.match(problems.errors[3] ?? "", /0 to 1,200/)
  assert.equal(problems.errors[4], "Choose the default date.")

  // New rows get names that are free.
  assert.equal(newParameter([]).name, "since")
  assert.equal(newParameter(drafts).name, "day")
  assert.equal(newParameter([...drafts, { ...newParameter([]), name: "day" }]).name, "date_2")

  // Stored definitions round-trip through their rows.
  const monthsAgo = { ...since, default: { kind: "relative" as const, value: "months_ago:3" } }
  for (const definition of [since, until, region, monthsAgo]) {
    const back = parameterDefinitions([parameterDraft(definition)])
    assert.ok("definitions" in back)
    assert.deepEqual(back.definitions[0], definition)
  }
  assert.equal(
    parametersSummary(parametersText([since, until].map(parameterDraft))),
    "since (Date, Start of this month), until (Date and time, No default)",
  )
})

test("an edit sends only what changed, and only the creator or a manager may change it", () => {
  const savedQuery = {
    name: "Orders in a range",
    description: "",
    query: { language: "sql" as const, sql: "SELECT count(*) FROM orders WHERE ordered_at >= {{since}}" },
    parameters: [since],
    visibility: "workspace" as const,
  }
  const base = savedQueryFields(savedQuery)
  const state = startDraft(base, 4)
  assert.deepEqual(updatePatch(state, "postgres"), { patch: { version: 4 } })
  const changed = { ...state, draft: { ...base, name: "Orders since", visibility: "private" } }
  assert.deepEqual(updatePatch(changed, "postgres"), {
    patch: { version: 4, name: "Orders since", visibility: "private" },
  })
  const withParameter = {
    ...state,
    draft: { ...base, parameters: parametersText([parameterDraft(since), parameterDraft(until)]) },
  }
  const patched = updatePatch(withParameter, "postgres")
  assert.ok("patch" in patched)
  assert.deepEqual(patched.patch.parameters, [since, until])

  const author = { createdBy: { id: "u1", name: "Alice" } }
  assert.ok(canChangeSavedQuery(author, "u1", "member"))
  assert.ok(!canChangeSavedQuery(author, "u2", "member"))
  assert.ok(canChangeSavedQuery(author, "u2", "admin"))
  assert.ok(canChangeSavedQuery({ createdBy: null }, "u2", "owner"))
  assert.ok(!canChangeSavedQuery({ createdBy: null }, undefined, "member"))
})
