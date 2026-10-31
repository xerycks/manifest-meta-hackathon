import { parse } from "libpg-query"

import type { Rejection, RejectionReason } from "./schemas.js"

// Validates SQL with PostgreSQL's own parser (libpg_query, compiled to WASM).
// This is the first layer: execution also runs in a READ ONLY transaction
// whose search_path holds only the selected schemas, through the extended
// protocol, which refuses more than one statement.

export interface SqlScope {
  /** The connection's selected schemas. */
  schemas: string[]
  /** Names of present tables and views in those schemas, which unqualified names may use. */
  objects: string[]
}

/**
 * Functions that act outside the transaction (session locks, notifications,
 * settings, other sessions), read the server's files or activity, reach other
 * servers, or run SQL from a string. Matched by exact name or by prefix.
 */
const DENIED_FUNCTIONS = new Set([
  "set_config",
  "pg_notify",
  "pg_cancel_backend",
  "pg_terminate_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_stat_file",
  "pg_current_logfile",
  "pg_switch_wal",
  "pg_promote",
  "pg_import_system_collations",
  "pg_log_backend_memory_contexts",
  "pg_drop_replication_slot",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_show_all_file_settings",
  "pg_hba_file_rules",
  "pg_ident_file_mappings",
  "pg_lock_status",
  "pg_config",
  "gin_clean_pending_list",
  "get_raw_page",
  "loread",
  "lowrite",
  // Run a query given as text, which escapes the relation checks.
  "ts_stat",
  "ts_rewrite",
])
const DENIED_PREFIXES = [
  "dblink",
  "lo_",
  "pg_read_",
  "pg_ls_",
  "pg_file_",
  "pg_advisory",
  "pg_try_advisory",
  "pg_stat_get_",
  "pg_stat_reset",
  "pg_create_",
  "pg_replication_",
  "pg_logical_",
  "pg_backup_",
  "pg_wal_replay_",
  "pg_control_",
  "pg_stat_statements",
  "binary_upgrade_",
  "brin_summarize",
  "brin_desummarize",
  "query_to_xml",
  "cursor_to_xml",
  "table_to_xml",
  "schema_to_xml",
  "database_to_xml",
  "http_",
]

export function isDeniedFunction(name: string): boolean {
  const lower = name.toLowerCase()
  return DENIED_FUNCTIONS.has(lower) || DENIED_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

const STATEMENT_NAMES: Record<string, string> = {
  InsertStmt: "INSERT",
  UpdateStmt: "UPDATE",
  DeleteStmt: "DELETE",
  MergeStmt: "MERGE",
  ExplainStmt: "EXPLAIN",
  CopyStmt: "COPY",
  TruncateStmt: "TRUNCATE",
  DropStmt: "DROP",
  CreateStmt: "CREATE TABLE",
  CreateTableAsStmt: "CREATE TABLE AS",
  VariableSetStmt: "SET",
  VariableShowStmt: "SHOW",
  TransactionStmt: "a transaction command",
  DoStmt: "DO",
  CallStmt: "CALL",
  LockStmt: "LOCK",
  DeclareCursorStmt: "DECLARE",
  FetchStmt: "FETCH",
  PrepareStmt: "PREPARE",
  ExecuteStmt: "EXECUTE",
  NotifyStmt: "NOTIFY",
  ListenStmt: "LISTEN",
  VacuumStmt: "VACUUM",
  RefreshMatViewStmt: "REFRESH MATERIALIZED VIEW",
}

const DATA_MODIFYING = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"])

const ONLY_READS = "Only one read statement can run: SELECT, VALUES, TABLE, or WITH … SELECT."

class Rejected extends Error {
  constructor(readonly rejection: Rejection) {
    super(rejection.message)
  }
}

function reject(reason: RejectionReason, message: string, name: string | null = null): never {
  throw new Rejected({ reason, message, name })
}

type AstObject = Record<string, unknown>

const isObject = (value: unknown): value is AstObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The text of a list of String nodes, e.g. ["pg_catalog", "now"]. */
function nameParts(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.map((node) => {
    const value = isObject(node) && isObject(node.String) ? node.String.sval : undefined
    return typeof value === "string" ? value : ""
  })
}

const quoteList = (names: Iterable<string>) => [...names].join(", ") || "none"

class SqlChecker {
  private readonly schemas: Set<string>
  private readonly objects: Set<string>

  constructor(scope: SqlScope) {
    this.schemas = new Set(scope.schemas)
    this.objects = new Set(scope.objects)
  }

  /** Every node of the tree, with the CTE names visible at that point. */
  visit(value: unknown, visible: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) this.visit(item, visible)
      return
    }
    if (!isObject(value)) return
    // SelectStmt shows up both wrapped ({SelectStmt: …}) and bare (set operation arms).
    if (typeof value.op === "string" && value.op.startsWith("SETOP_")) {
      this.visitSelect(value, visible)
      return
    }
    this.inspect(value, visible)
    for (const [key, child] of Object.entries(value)) {
      if (DATA_MODIFYING.has(key)) {
        reject(
          "statement_not_allowed",
          `${ONLY_READS} A WITH clause cannot contain ${STATEMENT_NAMES[key]}.`,
          STATEMENT_NAMES[key] ?? key,
        )
      }
      this.visit(child, visible)
    }
  }

  private visitSelect(select: AstObject, visible: ReadonlySet<string>): void {
    if (select.intoClause) {
      reject("statement_not_allowed", `${ONLY_READS} SELECT INTO creates a table.`, "SELECT INTO")
    }
    if (select.lockingClause) {
      reject(
        "statement_not_allowed",
        "Locking clauses (FOR UPDATE, FOR SHARE, …) are not allowed: queries only read.",
        "FOR UPDATE",
      )
    }
    let scope = visible
    const withClause = isObject(select.withClause) ? select.withClause : null
    if (withClause) {
      const ctes = (Array.isArray(withClause.ctes) ? withClause.ctes : []).map((node) =>
        isObject(node) && isObject(node.CommonTableExpr) ? node.CommonTableExpr : {},
      )
      const names = ctes.map((cte) => String(cte.ctename ?? ""))
      // A plain WITH sees only the CTEs before it; WITH RECURSIVE sees all of them.
      ctes.forEach((cte, index) => {
        const seen = withClause.recursive === true ? names : names.slice(0, index)
        this.visit(cte.ctequery, new Set([...visible, ...seen]))
      })
      scope = new Set([...visible, ...names])
    }
    for (const [key, child] of Object.entries(select)) {
      if (key !== "withClause") this.visit(child, scope)
    }
  }

  private inspect(node: AstObject, visible: ReadonlySet<string>): void {
    if (typeof node.relname === "string") this.checkRelation(node, visible)
    if (Array.isArray(node.funcname)) this.checkFunction(nameParts(node.funcname))
    // TABLESAMPLE methods are functions too.
    if (isObject(node.relation) && Array.isArray(node.method)) this.checkFunction(nameParts(node.method))
    // Operators written as OPERATOR(schema.op).
    if (typeof node.kind === "string" && node.kind.startsWith("AEXPR_")) {
      this.checkQualified(nameParts(node.name), "operator")
    }
    // Type names, e.g. in casts.
    if ("typemod" in node && Array.isArray(node.names)) {
      this.checkQualified(nameParts(node.names), "type")
    }
  }

  private checkRelation(node: AstObject, visible: ReadonlySet<string>): void {
    const relname = String(node.relname)
    const schemaname = typeof node.schemaname === "string" ? node.schemaname : null
    if (typeof node.catalogname === "string") {
      const name = `${node.catalogname}.${schemaname}.${relname}`
      reject("relation_not_allowed", `"${name}" refers to another database.`, name)
    }
    if (schemaname !== null) {
      if (!this.schemas.has(schemaname)) {
        const name = `${schemaname}.${relname}`
        reject(
          "relation_not_allowed",
          `"${name}" is outside the schemas this source may read (${quoteList(this.schemas)}).`,
          name,
        )
      }
      return
    }
    if (visible.has(relname)) return
    if (relname.startsWith("pg_")) {
      reject(
        "relation_not_allowed",
        `"${relname}" could resolve to a PostgreSQL system catalog. Qualify it with its schema.`,
        relname,
      )
    }
    if (!this.objects.has(relname)) {
      reject(
        "relation_not_allowed",
        `"${relname}" is not a table or view in this source's manifest. Qualify it with one of its schemas (${quoteList(this.schemas)}), or refresh the manifest if it is new.`,
        relname,
      )
    }
  }

  private checkFunction(parts: string[]): void {
    this.checkQualified(parts, "function")
    const name = parts.at(-1) ?? ""
    if (isDeniedFunction(name)) {
      reject(
        "function_not_allowed",
        `${name}() is not allowed: it acts outside the query, reads the server, or reaches another database.`,
        name,
      )
    }
  }

  /** A schema-qualified function, operator, or type must come from pg_catalog or a selected schema. */
  private checkQualified(parts: string[], what: string): void {
    if (parts.length < 2) return
    const schema = parts.length > 2 ? "" : (parts[0] ?? "")
    if (schema === "pg_catalog" || this.schemas.has(schema)) return
    const name = parts.join(".")
    reject(
      "schema_not_allowed",
      `The ${what} "${name}" is outside the schemas this source may read (${quoteList(this.schemas)}).`,
      name,
    )
  }
}

function syntaxError(error: unknown): Rejection {
  const details = (error as { sqlDetails?: { cursorPosition?: number } }).sqlDetails
  const position = details?.cursorPosition
  const message = (error instanceof Error ? error.message : "the SQL could not be parsed").replace(/\.$/, "")
  const at = position !== undefined && position >= 0 ? ` (at character ${position + 1})` : ""
  return {
    reason: "syntax_error",
    message: `${message.charAt(0).toUpperCase()}${message.slice(1)}${at}.`,
    name: null,
  }
}

/** Null when the SQL may run, otherwise why not. */
export async function validateSql(sql: string, scope: SqlScope): Promise<Rejection | null> {
  let statements: unknown[]
  try {
    statements = (await parse(sql)).stmts ?? []
  } catch (error) {
    return syntaxError(error)
  }
  if (statements.length === 0) {
    return { reason: "syntax_error", message: "Enter a SELECT statement.", name: null }
  }
  if (statements.length > 1) {
    return {
      reason: "multiple_statements",
      message: `${ONLY_READS} This SQL has ${statements.length} statements.`,
      name: null,
    }
  }
  const node = isObject(statements[0]) ? statements[0].stmt : null
  const [type, body] = isObject(node) ? (Object.entries(node)[0] ?? []) : []
  if (type !== "SelectStmt") {
    const name = (type && STATEMENT_NAMES[type]) ?? type?.replace(/Stmt$/, "").toUpperCase() ?? "?"
    return { reason: "statement_not_allowed", message: `${ONLY_READS} This is ${name}.`, name }
  }
  try {
    new SqlChecker(scope).visit(body, new Set())
    return null
  } catch (error) {
    if (error instanceof Rejected) return error.rejection
    // The tree is walked recursively; thousands of nested parts exhaust the stack.
    if (error instanceof RangeError) {
      return {
        reason: "invalid_query",
        message: "The query is nested too deeply to check. Split it into simpler parts.",
        name: null,
      }
    }
    throw error
  }
}
