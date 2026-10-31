import assert from "node:assert/strict"
import test from "node:test"

import { validateSql } from "../../src/queries/sql-validator.js"
import { AppError } from "../../src/shared/http/errors.js"
import {
  checkPlaceholders,
  clockWarnings,
  compileQuery,
  type BoundValue,
} from "../../src/saved-queries/compile.js"
import { formatInstant, instantOf } from "../../src/saved-queries/dates.js"
import { resolveParameters, resolveValue } from "../../src/saved-queries/parameters.js"
import {
  createSavedQuerySchema,
  parameterDefinitionSchema,
  type ParameterDefinition,
  type ParameterType,
} from "../../src/saved-queries/schemas.js"

/** Saturday 2026-10-31 20:00 UTC: already Sunday 1 November in India, still Saturday in California. */
const NOW = Date.parse("2026-10-31T20:00:00Z")

const relative = (value: string, type: ParameterType = "date", timeZone = "UTC", now = NOW) =>
  resolveValue({ kind: "relative", value }, type, timeZone, now).value
const absolute = (value: string, type: ParameterType, timeZone = "UTC") =>
  resolveValue({ kind: "absolute", value }, type, timeZone, NOW).value

const definition = (input: Record<string, unknown>): ParameterDefinition =>
  parameterDefinitionSchema.parse(input)

const bound = (entries: Record<string, string | null>, instant = 0) =>
  new Map<string, BoundValue>(
    Object.entries(entries).map(([name, value]) => [name, { value, instant: value === null ? null : instant }]),
  )

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AppError, String(error))
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return error
  }
  assert.fail(`expected ${code}`)
}

function throws(run: () => unknown, code: string): AppError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof AppError, String(error))
    assert.equal(error.code, code, error.message)
    return error
  }
  assert.fail(`expected ${code}`)
}

test("relative dates are calendar dates in the workspace time zone", () => {
  assert.equal(relative("today"), "2026-10-31")
  assert.equal(relative("today", "date", "Asia/Kolkata"), "2026-11-01")
  assert.equal(relative("today", "date", "America/Los_Angeles"), "2026-10-31")
  assert.equal(relative("yesterday", "date", "Asia/Kolkata"), "2026-10-31")
  // ISO weeks start on Monday; a Sunday belongs to the week before.
  assert.equal(relative("start_of_week"), "2026-10-26")
  assert.equal(relative("start_of_week", "date", "Asia/Kolkata"), "2026-10-26")
  assert.equal(relative("start_of_week", "date", "UTC", Date.parse("2026-11-02T00:00:00Z")), "2026-11-02")
  assert.equal(relative("start_of_month"), "2026-10-01")
  assert.equal(relative("start_of_month", "date", "Asia/Kolkata"), "2026-11-01")
  assert.equal(relative("start_of_quarter"), "2026-10-01")
  assert.equal(relative("start_of_quarter", "date", "UTC", Date.parse("2026-06-30T12:00:00Z")), "2026-04-01")
  assert.equal(relative("start_of_year"), "2026-01-01")
  assert.equal(relative("days_ago:0"), "2026-10-31")
  assert.equal(relative("days_ago:31"), "2026-09-30")
  assert.equal(relative("days_ago:365"), "2025-10-31")
  assert.equal(relative("months_ago:1"), "2026-09-30")
  assert.equal(relative("months_ago:8"), "2026-02-28")
  assert.equal(relative("months_ago:12"), "2025-10-31")
  // A month that is shorter takes its last day, also in leap years.
  assert.equal(relative("months_ago:1", "date", "UTC", Date.parse("2024-03-31T12:00:00Z")), "2024-02-29")
})

test("datetime parameters start at the first instant of their day, with the zone's offset", () => {
  assert.equal(relative("start_of_month", "datetime"), "2026-10-01T00:00:00+00:00")
  assert.equal(relative("start_of_month", "datetime", "Asia/Kolkata"), "2026-11-01T00:00:00+05:30")
  assert.equal(relative("today", "datetime", "America/Los_Angeles"), "2026-10-31T00:00:00-07:00")
  assert.equal(absolute("2026-10-01", "datetime", "Asia/Kolkata"), "2026-10-01T00:00:00+05:30")
  // A datetime with its own offset keeps its instant and is shown in the workspace zone.
  assert.equal(absolute("2026-10-01T00:00:00Z", "datetime", "Asia/Kolkata"), "2026-10-01T05:30:00+05:30")
  assert.equal(absolute("2026-10-01T09:30:15.250-04:00", "datetime"), "2026-10-01T13:30:15.250+00:00")
  // Without an offset it is wall-clock time in the workspace zone.
  assert.equal(absolute("2026-10-01T09:30", "datetime", "Europe/Berlin"), "2026-10-01T09:30:00+02:00")
})

test("DST: skipped times move forward, repeated times take the first, days start when clocks allow", () => {
  // New York springs forward at 02:00 on 8 March 2026: 02:30 never happens.
  assert.equal(absolute("2026-03-08T02:30", "datetime", "America/New_York"), "2026-03-08T03:30:00-04:00")
  // It falls back at 02:00 on 1 November 2026: 01:30 happens twice.
  assert.equal(absolute("2026-11-01T01:30", "datetime", "America/New_York"), "2026-11-01T01:30:00-04:00")
  assert.equal(absolute("2026-11-01", "datetime", "America/New_York"), "2026-11-01T00:00:00-04:00")
  assert.equal(absolute("2026-11-02", "datetime", "America/New_York"), "2026-11-02T00:00:00-05:00")
  // Berlin falls back at 03:00 on 25 October 2026.
  assert.equal(absolute("2026-10-25T02:30", "datetime", "Europe/Berlin"), "2026-10-25T02:30:00+02:00")
  assert.equal(absolute("2026-10-26", "datetime", "Europe/Berlin"), "2026-10-26T00:00:00+01:00")
  // Santiago springs forward at midnight on 6 September 2026, so that day starts at 01:00.
  assert.equal(absolute("2026-09-06", "datetime", "America/Santiago"), "2026-09-06T01:00:00-03:00")
  // A relative day resolved on either side of a change keeps its own offset.
  const afterChange = Date.parse("2026-11-01T12:00:00Z")
  assert.equal(relative("yesterday", "datetime", "America/New_York", afterChange), "2026-10-31T00:00:00-04:00")
  assert.equal(relative("today", "datetime", "America/New_York", afterChange), "2026-11-01T00:00:00-04:00")
  // The two instants named 01:30 are an hour apart; the first one is chosen.
  const first = instantOf(
    { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0, millisecond: 0 },
    "America/New_York",
  )
  assert.equal(new Date(first).toISOString(), "2026-11-01T05:30:00.000Z")
  assert.equal(formatInstant(first + 3_600_000, "America/New_York"), "2026-11-01T01:30:00-05:00")
})

test("fixed values must be real dates of the parameter's type", () => {
  assert.equal(absolute("2024-02-29", "date"), "2024-02-29")
  assert.throws(() => absolute("2026-02-30", "date"), /not a date/)
  assert.throws(() => absolute("2026-13-01", "date"), /not a date/)
  assert.throws(() => absolute("0999-01-01", "date"), /between the years 1000 and 9999/)
  assert.throws(() => absolute("2026-10-01T10:00", "date"), /Use a date like 2026-10-01/)
  assert.throws(() => absolute("2026-10-01T24:00", "datetime"), /not a time of day/)
  assert.throws(() => absolute("next tuesday", "datetime"), /not a date or datetime/)
  assert.throws(() => relative("weeks_ago:2"), /not a relative date/)
})

test("run values override defaults; unknown, missing, and invalid values give one 422 naming them", () => {
  const definitions = [
    definition({ name: "since", type: "date", default: { kind: "relative", value: "start_of_month" } }),
    definition({ name: "until", label: "Until", type: "datetime", required: true }),
    definition({ name: "region_day", type: "date", required: false }),
  ]
  const context = { timeZone: "Asia/Kolkata", now: NOW, requireValues: true }
  const resolved = resolveParameters(definitions, { until: "2026-11-15T18:00", since: "days_ago:7" }, context)
  assert.deepEqual(
    resolved.parameters.map(({ name, label, from, value }) => ({ name, label, from, value })),
    [
      { name: "since", label: "since", from: "run", value: "2026-10-25" },
      { name: "until", label: "Until", from: "run", value: "2026-11-15T18:00:00+05:30" },
      { name: "region_day", label: "region_day", from: null, value: null },
    ],
  )
  assert.equal(resolved.instants.get("since"), Date.parse("2026-10-24T18:30:00Z"))
  assert.deepEqual(resolved.parameters[0]?.input, { kind: "relative", value: "days_ago:7" })

  const defaults = resolveParameters(definitions, { until: "2026-11-15" }, context)
  assert.deepEqual(defaults.parameters[0], {
    name: "since",
    label: "since",
    type: "date",
    from: "default",
    input: { kind: "relative", value: "start_of_month" },
    value: "2026-11-01",
  })

  const error = throws(
    () => resolveParameters(definitions, { since: "2026-02-31", regoin: "2026-01-01" }, context),
    "INVALID_PARAMETERS",
  )
  assert.equal(error.status, 422)
  assert.deepEqual(error.details, {
    unknown: ["regoin"],
    missing: ["until"],
    invalid: [{ name: "since", message: "2026-02-31 is not a date between the years 1000 and 9999." }],
  })
  assert.match(error.message, /regoin/)
  assert.match(error.message, /until needs a value/)

  // Explicitly no value is fine for an optional parameter, and resolving defaults never demands one.
  const none = resolveParameters(definitions, { until: "2026-11-15", region_day: null }, context)
  assert.equal(none.parameters[2]?.from, "run")
  assert.equal(resolveParameters(definitions, {}, { ...context, requireValues: false }).parameters[1]?.value, null)
})

test("parameter names are identifiers, unique regardless of case", () => {
  for (const name of ["start", "_from", "day_2", "Start_Date"]) {
    assert.ok(parameterDefinitionSchema.safeParse({ name, type: "date" }).success, name)
  }
  for (const name of ["2day", "from-date", "a b", "x}}; DROP TABLE t; --{{y", "", "a".repeat(64)]) {
    assert.ok(!parameterDefinitionSchema.safeParse({ name, type: "date" }).success, name)
  }
  const duplicate = createSavedQuerySchema.safeParse({
    name: "Orders",
    connectionId: "6f1d1c6e-8f3e-4f0e-9f1a-2b3c4d5e6f70",
    query: { language: "sql", sql: "SELECT {{day}}, {{Day}}" },
    parameters: [
      { name: "day", type: "date" },
      { name: "Day", type: "date" },
    ],
  })
  assert.ok(!duplicate.success)
  assert.match(duplicate.error.issues[0]?.message ?? "", /Two parameters are named Day/)

  // Positional values are what a run binds, never part of the saved definition.
  const positional = createSavedQuerySchema.safeParse({
    name: "Orders",
    connectionId: "6f1d1c6e-8f3e-4f0e-9f1a-2b3c4d5e6f70",
    query: { language: "sql", sql: "SELECT {{day}}", params: ["2026-10-01"] },
    parameters: [{ name: "day", type: "date" }],
  })
  assert.ok(!positional.success)
  assert.deepEqual(positional.error.issues[0]?.path, ["query", "params"])
})

test(
  "SQL placeholders become positional parameters by first use; literals and comments are left alone",
  async () => {
    const compiled = await compileQuery({
      language: "sql",
      sql: [
        "SELECT '{{a}}' AS literal, $$ {{a}} $$ AS dollar, \"{{a}}\" AS quoted, E'\\'{{a}}' AS escaped",
        "FROM shop.orders -- {{ignored}}",
        "WHERE ordered_at >= {{since}} AND ordered_at < {{ until }}::timestamptz /* {{c}} */",
        "  AND {{since}} IS NOT NULL",
      ].join("\n"),
    })
    assert.deepEqual(compiled.names, ["since", "until"])
    const query = compiled.bind(bound({ since: "2026-10-01", until: "2026-11-01T00:00:00+05:30" }))
    assert.equal(query.language, "sql")
    assert.ok(query.language === "sql")
    assert.deepEqual(query.params, ["2026-10-01", "2026-11-01T00:00:00+05:30"])
    assert.match(query.sql, /ordered_at >= \$1 AND ordered_at < \$2::timestamptz/)
    assert.match(query.sql, /AND \$1 IS NOT NULL/)
    assert.match(query.sql, /'\{\{a\}\}' AS literal, \$\$ \{\{a\}\} \$\$ AS dollar, "\{\{a\}\}" AS quoted/)
    assert.match(query.sql, /-- \{\{ignored\}\}/)
    assert.match(query.sql, /\/\* \{\{c\}\} \*\//)

    // Next to an identifier or number, $n is set apart so it cannot join it.
    const joined = (await compileQuery({ language: "sql", sql: "SELECT x{{a}}, {{a}}1" })).bind(bound({ a: "v" }))
    assert.ok(joined.language === "sql")
    assert.equal(joined.sql, "SELECT x $1, $1 1")

    // Without placeholders the SQL is sent as written, with no parameter values.
    assert.deepEqual((await compileQuery({ language: "sql", sql: "SELECT 1" })).bind(new Map()), {
      language: "sql",
      sql: "SELECT 1",
    })

    // Non-ASCII text before a placeholder does not shift it.
    const unicode = await compileQuery({ language: "sql", sql: "SELECT 'é€😀{{x}}', {{y}}" })
    assert.deepEqual(unicode.names, ["y"])

    // Unicode-escape strings and identifiers are data too, placeholder-like text and all.
    const escapes = await compileQuery({
      language: "sql",
      sql: `SELECT U&'{{a}} {{not one}}' AS text, u&"{{a}}" AS name, B'0101' AS bits, {{b}}`,
    })
    assert.deepEqual(escapes.names, ["b"])
    const kept = escapes.bind(bound({ b: "2026-10-01" }))
    assert.ok(kept.language === "sql")
    assert.equal(kept.sql, `SELECT U&'{{a}} {{not one}}' AS text, u&"{{a}}" AS name, B'0101' AS bits, $1`)
  },
)

test("parameter values are bound, never written into the SQL", async () => {
  const injection = "2026-10-01'; DROP TABLE shop.orders; --"
  const compiled = await compileQuery({
    language: "sql",
    sql: "SELECT * FROM shop.orders WHERE ordered_at >= {{since}}",
  })
  const query = compiled.bind(bound({ since: injection }))
  assert.ok(query.language === "sql")
  assert.equal(query.sql, "SELECT * FROM shop.orders WHERE ordered_at >= $1")
  assert.deepEqual(query.params, [injection])
  // Such a value never resolves in the first place.
  assert.throws(() => absolute(injection, "date"), /not a date/)
  assert.throws(() => absolute("2026-10-01T00:00:00Z' OR '1'='1", "datetime"), /not a date or datetime/)
})

test(
  "malformed placeholders, positional parameters, and mismatched definitions give a 422 that names them",
  async () => {
    const malformed = await rejects(
      compileQuery({ language: "sql", sql: "SELECT {{from-date}}, {{a; DROP TABLE t}} FROM t" }),
      "INVALID_PARAMETERS",
    )
    assert.deepEqual(malformed.details, { malformed: ["{{from-date}}", "{{a; DROP TABLE t}}"] })
    const positional = compileQuery({ language: "sql", sql: "SELECT * FROM t WHERE a = $1" })
    await rejects(positional, "INVALID_PARAMETERS", /\$1/)
    await rejects(compileQuery({ language: "sql", sql: "SELECT 'unterminated" }), "QUERY_REJECTED", /Unterminated/)

    const compiled = await compileQuery({ language: "sql", sql: "SELECT {{since}}, {{region}}" })
    const mismatch = throws(
      () =>
        checkPlaceholders(compiled, [
          definition({ name: "since", type: "date" }),
          definition({ name: "until", type: "date" }),
        ]),
      "INVALID_PARAMETERS",
    )
    assert.deepEqual(mismatch.details, { unknown: ["region"], unused: ["until"] })
    assert.match(mismatch.message, /No parameter is defined for region/)
    assert.match(mismatch.message, /does not use until/)
  },
)

test("MongoDB {$param} placeholders become dates in filters and pipelines", async () => {
  const instant = Date.parse("2026-09-30T18:30:00Z")
  const find = await compileQuery({
    language: "mongodb",
    database: "store",
    collection: "orders",
    operation: "find",
    filter: { placed_at: { $gte: { $param: "since" }, $lt: { $param: "until" } }, "notes.$param": "kept" },
    sort: { placed_at: 1 },
  })
  assert.deepEqual(find.names, ["since", "until"])
  assert.deepEqual(find.bind(bound({ since: "2026-10-01", until: null }, instant)), {
    language: "mongodb",
    database: "store",
    collection: "orders",
    operation: "find",
    filter: { placed_at: { $gte: { $date: "2026-09-30T18:30:00.000Z" }, $lt: null }, "notes.$param": "kept" },
    sort: { placed_at: 1 },
  })

  const aggregate = await compileQuery({
    language: "mongodb",
    database: "store",
    collection: "orders",
    operation: "aggregate",
    pipeline: [{ $match: { $expr: { $and: [{ $gte: ["$placed_at", { $param: "since" }] }] } } }],
  })
  assert.deepEqual(aggregate.names, ["since"])
  assert.deepEqual(aggregate.bind(bound({ since: "x" }, instant)), {
    language: "mongodb",
    database: "store",
    collection: "orders",
    operation: "aggregate",
    pipeline: [{ $match: { $expr: { $and: [{ $gte: ["$placed_at", { $date: "2026-09-30T18:30:00.000Z" }] }] } } }],
  })

  for (const placeholder of [{ $param: 1 }, { $param: "since", extra: true }, { $param: "not a name" }]) {
    await rejects(
      compileQuery({
        language: "mongodb",
        database: "store",
        collection: "orders",
        operation: "find",
        filter: { placed_at: placeholder },
      }),
      "INVALID_PARAMETERS",
    )
  }
})

test("queries that read the database clock get a warning, not a refusal", async () => {
  const sql = await compileQuery({
    language: "sql",
    sql:
      "SELECT * FROM t WHERE a > now() - interval '1 day' AND b = current_date " +
      "AND c < 'today'::date AND d >= {{since}}",
  })
  assert.deepEqual(sql.clock, ["now()", "current_date", "'today'"])
  const [warning] = clockWarnings(sql)
  assert.equal(warning?.code, "database_clock")
  assert.match(warning?.message ?? "", /now\(\), current_date, 'today'/)

  const mongo = await compileQuery({
    language: "mongodb",
    database: "store",
    collection: "orders",
    operation: "aggregate",
    pipeline: [{ $match: { $expr: { $lt: ["$placed_at", "$$NOW"] } } }],
  })
  assert.deepEqual(mongo.clock, ["$$NOW"])
  assert.deepEqual(clockWarnings(await compileQuery({ language: "sql", sql: "SELECT {{since}}::date" })), [])
})

test("the SQL validator checks positional parameter values against the $n the SQL uses", async () => {
  const scope = { schemas: ["shop"], objects: ["orders"] }
  const range = "SELECT * FROM orders WHERE ordered_at >= $1 AND ordered_at < $2"
  assert.equal(await validateSql(range, scope, 2), null)
  assert.equal(await validateSql("SELECT $1, $1::date", scope, 1), null)
  const extra = await validateSql("SELECT $1, $3", scope, 2)
  assert.equal(extra?.reason, "invalid_query")
  assert.equal(extra?.name, "$3")
  assert.match(extra?.message ?? "", /uses \$3, but only 2 parameter values were sent/)
  const unused = await validateSql("SELECT $2", scope, 2)
  assert.equal(unused?.name, "$1")
  const none = await validateSql("SELECT * FROM orders WHERE id = $1", scope)
  assert.match(none?.message ?? "", /no parameter values were sent/)
})
