import assert from "node:assert/strict"
import test from "node:test"

import { sqlQuerySchema, type RejectionReason } from "../../src/queries/schemas.js"
import { isDeniedFunction, validateSql } from "../../src/queries/sql-validator.js"

const scope = { schemas: ["shop", "support"], objects: ["orders", "customers", "tickets"] }

const allowed = [
  "SELECT 1",
  "SELECT 1;",
  "SELECT 1 -- ; DROP TABLE shop.orders",
  "SELECT a.id, b.id FROM shop.orders a JOIN orders b ON a.id = b.id",
  "SELECT c.country, count(*), sum(o.total) FROM orders o JOIN shop.customers c ON c.id = o.customer_id GROUP BY 1",
  "SELECT * FROM shop.orders UNION ALL SELECT * FROM support.tickets",
  "SELECT id, rank() OVER (PARTITION BY customer_id ORDER BY total DESC) FROM shop.orders",
  "SELECT (SELECT max(id) FROM shop.orders), EXISTS (SELECT 1 FROM tickets)",
  "TABLE shop.orders",
  "VALUES (1, 'a'), (2, 'b')",
  "WITH recent AS (SELECT * FROM shop.orders) SELECT count(*) FROM recent",
  "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b",
  "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT * FROM t",
  // A CTE named like a catalog shadows it, as PostgreSQL resolves the CTE first.
  "WITH pg_class AS (SELECT 1 AS x) SELECT * FROM pg_class",
  'SELECT * FROM "shop"."orders"',
  "SELECT pg_sleep(0.1), current_setting('server_version'), now(), pg_catalog.lower('A')",
  "SELECT '2026-01-01'::date, 1::pg_catalog.int8, '{}'::jsonb",
  "SELECT * FROM generate_series(1, 3) AS g(n)",
  "SELECT * FROM shop.orders TABLESAMPLE system (10)",
]

for (const sql of allowed) {
  test(`allows: ${sql}`, async () => {
    assert.equal(await validateSql(sql, scope), null)
  })
}

const rejected: [string, RejectionReason, string | null][] = [
  ["", "syntax_error", null],
  ["SELEC 1", "syntax_error", null],
  ["SELECT 1; SELECT 2", "multiple_statements", null],
  // The comment hides nothing: the semicolon after it ends the first statement.
  ["SELECT 1 /* ; */ ; DROP TABLE shop.orders", "multiple_statements", null],
  ["INSERT INTO shop.orders (id) VALUES (1)", "statement_not_allowed", "INSERT"],
  ["UPDATE shop.orders SET total = 0", "statement_not_allowed", "UPDATE"],
  ["DELETE FROM shop.orders", "statement_not_allowed", "DELETE"],
  ["EXPLAIN SELECT 1", "statement_not_allowed", "EXPLAIN"],
  ["SET statement_timeout = 0", "statement_not_allowed", "SET"],
  ["COPY shop.orders TO STDOUT", "statement_not_allowed", "COPY"],
  ["BEGIN", "statement_not_allowed", "a transaction command"],
  ["WITH gone AS (DELETE FROM shop.orders RETURNING *) SELECT * FROM gone", "statement_not_allowed", "DELETE"],
  ["WITH x AS (UPDATE shop.orders SET total = 0 RETURNING id) SELECT 1", "statement_not_allowed", "UPDATE"],
  ["SELECT * INTO shop.copy FROM shop.orders", "statement_not_allowed", "SELECT INTO"],
  ["SELECT * FROM shop.orders FOR UPDATE", "statement_not_allowed", "FOR UPDATE"],
  ["SELECT * FROM (SELECT * FROM shop.orders FOR SHARE) s", "statement_not_allowed", "FOR UPDATE"],
  ["SELECT set_config('statement_timeout', '0', false)", "function_not_allowed", "set_config"],
  ["SELECT pg_catalog.set_config('search_path', 'public', true)", "function_not_allowed", "set_config"],
  ["SELECT pg_advisory_lock(1)", "function_not_allowed", "pg_advisory_lock"],
  ["SELECT pg_try_advisory_lock(1)", "function_not_allowed", "pg_try_advisory_lock"],
  ["SELECT pg_terminate_backend(1)", "function_not_allowed", "pg_terminate_backend"],
  ["SELECT pg_read_file('/etc/passwd')", "function_not_allowed", "pg_read_file"],
  ["SELECT * FROM pg_ls_dir('.')", "function_not_allowed", "pg_ls_dir"],
  ["SELECT lo_import('/etc/passwd')", "function_not_allowed", "lo_import"],
  ["SELECT * FROM dblink('host=elsewhere', 'SELECT 1') AS t(x int)", "function_not_allowed", "dblink"],
  ["SELECT pg_notify('channel', 'hello')", "function_not_allowed", "pg_notify"],
  ["SELECT query_to_xml('SELECT * FROM pg_authid', true, false, '')", "function_not_allowed", "query_to_xml"],
  ["SELECT (SELECT max(id) FROM shop.orders), pg_reload_conf()", "function_not_allowed", "pg_reload_conf"],
  // These run a query given as text, which would escape the relation checks.
  ["SELECT * FROM ts_stat('SELECT to_tsvector(rolname) FROM pg_catalog.pg_authid')", "function_not_allowed", "ts_stat"],
  ["SELECT ts_rewrite('a'::tsquery, 'SELECT t, s FROM public.aliases')", "function_not_allowed", "ts_rewrite"],
  ["SELECT * FROM pg_hba_file_rules()", "function_not_allowed", "pg_hba_file_rules"],
  ["SELECT pg_start_backup('x')", "function_not_allowed", "pg_start_backup"],
  ["SELECT * FROM shop.orders TABLESAMPLE public.sampler (10)", "schema_not_allowed", "public.sampler"],
  ["SELECT * FROM pg_stat_activity", "relation_not_allowed", "pg_stat_activity"],
  ["SELECT * FROM pg_catalog.pg_class", "relation_not_allowed", "pg_catalog.pg_class"],
  ["SELECT * FROM information_schema.tables", "relation_not_allowed", "information_schema.tables"],
  ["SELECT * FROM public.secrets", "relation_not_allowed", "public.secrets"],
  // Quoted identifiers keep their case, so "Shop" is not the selected schema shop.
  ['SELECT * FROM "Shop".orders', "relation_not_allowed", "Shop.orders"],
  ["SELECT * FROM otherdb.shop.orders", "relation_not_allowed", "otherdb.shop.orders"],
  ["SELECT * FROM unknown_table", "relation_not_allowed", "unknown_table"],
  // A plain WITH cannot see a later CTE, so this pg_class would be the catalog.
  ["WITH a AS (SELECT * FROM pg_class), pg_class AS (SELECT 1) SELECT * FROM a", "relation_not_allowed", "pg_class"],
  // A CTE inside a subquery is not visible outside it.
  ["SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) s, x", "relation_not_allowed", "x"],
  ["SELECT public.leak()", "schema_not_allowed", "public.leak"],
  ["SELECT 1 OPERATOR(public.+) 2", "schema_not_allowed", "public.+"],
  ["SELECT 'x'::public.secret_type", "schema_not_allowed", "public.secret_type"],
]

for (const [sql, reason, name] of rejected) {
  test(`rejects (${reason}): ${sql || "(empty)"}`, async () => {
    const rejection = await validateSql(sql, scope)
    assert.ok(rejection, "rejected")
    assert.equal(rejection.reason, reason)
    assert.equal(rejection.name, name)
    assert.ok(rejection.message.length > 10)
  })
}

test("rejection messages explain the rule and name the schemas", async () => {
  const outside = await validateSql("SELECT * FROM public.secrets", scope)
  assert.match(outside?.message ?? "", /outside the schemas this source may read \(shop, support\)/)
  const unknown = await validateSql("SELECT * FROM unknown_table", scope)
  assert.match(unknown?.message ?? "", /Qualify it with one of its schemas \(shop, support\)/)
  const syntax = await validateSql("SELECT * FORM shop.orders", scope)
  assert.equal(syntax?.message, 'Syntax error at or near "FORM" (at character 10).')
})

test("SQL nested too deeply to walk is rejected, not an internal error", async () => {
  const rejection = await validateSql(Array(5_000).fill("SELECT 1").join(" UNION ALL "), scope)
  assert.equal(rejection?.reason, "invalid_query")
  assert.match(rejection?.message ?? "", /nested too deeply/)
})

test("the function deny list matches exact names and families, case-insensitively", () => {
  for (const name of [
    "set_config",
    "PG_ADVISORY_XACT_LOCK",
    "dblink_connect",
    "lo_export",
    "pg_stat_get_activity",
    "pg_stat_statements_reset",
    "brin_summarize_new_values",
  ]) {
    assert.equal(isDeniedFunction(name), true, name)
  }
  for (const name of ["current_setting", "pg_sleep", "lower", "count", "date_trunc", "pg_typeof"]) {
    assert.equal(isDeniedFunction(name), false, name)
  }
})

test("SQL is bounded by its stored size as well as its length", () => {
  assert.equal(sqlQuerySchema.safeParse({ language: "sql", sql: `SELECT '${"x".repeat(99_000)}'` }).success, true)
  // Control characters are escaped six bytes each when the query is recorded.
  assert.equal(sqlQuerySchema.safeParse({ language: "sql", sql: "\u0001".repeat(40_000) }).success, false)
})

test("parameter values are bounded so the recorded query stays within its column's bound", () => {
  const sql = `SELECT '${"x".repeat(99_000)}', ${Array.from({ length: 100 }, (_, index) => `$${index + 1}`).join(", ")}`
  const fits = Array.from({ length: 100 }, () => "x".repeat(400))
  assert.equal(sqlQuerySchema.safeParse({ language: "sql", sql, params: fits }).success, true)
  // Each value is short enough, but together, escaped as they are recorded, they are not.
  const escaped = Array.from({ length: 100 }, () => "\u0001".repeat(1_000))
  const parsed = sqlQuerySchema.safeParse({ language: "sql", sql, params: escaped })
  assert.equal(parsed.success, false)
  assert.match(parsed.error?.issues[0]?.message ?? "", /parameter values are too large/)
  assert.ok(Buffer.byteLength(JSON.stringify({ language: "sql", sql, params: fits })) <= 300_000)
})
