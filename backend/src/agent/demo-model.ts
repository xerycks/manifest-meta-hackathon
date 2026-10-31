import type { Cell } from "../queries/schemas.js"
import { ScriptedProvider, type ScriptedTurn, type ScriptView } from "./scripted.js"

/** Shown as the run's model, so a scripted answer is never mistaken for a real model's. */
export const DEMO_MODEL = "demo (synthetic)"

const SIGNATURE =
  "_Answered by the scripted demo model (synthetic) with a fixed query; every number comes from the query result cited below._"

const UNSUPPORTED = [
  "I'm the scripted demo model (synthetic), not a language model, so I only answer a few fixed questions about the synthetic demo store: **net revenue by month**, **top products**, **top customers**, **refund rate**, and **open support tickets**.",
  "Set `ANTHROPIC_API_KEY` to ask anything else.",
].join("\n\n")

interface DemoQuery {
  purpose: string
  label: string
  sql: string
  /** Markdown built only from the query's rows. */
  answer(rows: Cell[][]): string
}

interface Scenario extends DemoQuery {
  matches: RegExp
  schema: "shop" | "support"
  /** Described before querying, as the instructions ask. */
  object: string
  /**
   * For an ambiguous question: what to ask the user, and the query an answer
   * (or the question itself) settles on; null when it settles nothing, and
   * then the scenario's own query is used.
   */
  clarify?: { question: string; options: string[]; choose(text: string): DemoQuery | null }
}

const text = (cell: Cell | undefined) =>
  cell === null || cell === undefined || typeof cell === "object" ? "—" : String(cell)

/** A number or exact decimal string with thousands separators; anything else as text. */
export function amount(cell: Cell | undefined): string {
  const value = text(cell)
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value)
  if (!match) return value
  const [, sign = "", whole = "", fraction = ""] = match
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction}`
}

function table(headers: string[], numeric: boolean[], rows: string[][]): string {
  const cell = (value: string) => value.replaceAll("|", "\\|")
  return [
    `| ${headers.join(" | ")} |`,
    `| ${numeric.map((right) => (right ? "---:" : "---")).join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

/** The row with the largest numeric value in a column. */
function largest(rows: Cell[][], column: number): Cell[] | undefined {
  return rows.reduce<Cell[] | undefined>(
    (best, row) => (best === undefined || Number(row[column]) > Number(best[column]) ? row : best),
    undefined,
  )
}

function customersBy(measure: "revenue" | "orders"): DemoQuery {
  const byRevenue = measure === "revenue"
  return {
    purpose: `Customers with the most ${byRevenue ? "revenue" : "orders"}`,
    label: `Top customers by ${byRevenue ? "revenue" : "number of orders"}`,
    sql: `SELECT c.full_name, c.segment, count(*) AS orders, sum(o.total) AS revenue
  FROM shop.customers c
  JOIN shop.orders o ON o.customer_id = c.id
 WHERE o.status NOT IN ('cancelled', 'refunded')
 GROUP BY c.id, c.full_name, c.segment
 ORDER BY ${byRevenue ? "revenue DESC, orders DESC" : "orders DESC, revenue DESC"}
 LIMIT 5`,
    answer(rows) {
      const top = rows[0]
      return [
        `**Top customers by ${byRevenue ? "revenue" : "number of orders"}** (orders that were not cancelled or refunded)`,
        table(
          ["#", "Customer", "Segment", "Orders", "Revenue (USD)"],
          [true, false, false, true, true],
          rows.map((row, index) => [
            String(index + 1),
            text(row[0]),
            text(row[1]),
            amount(row[2]),
            amount(row[3]),
          ]),
        ),
        `**${text(top?.[0])}** ranks first with ${amount(top?.[2])} orders and ${amount(top?.[3])} USD.`,
      ].join("\n\n")
    },
  }
}

const SCENARIOS: Scenario[] = [
  {
    matches: /(top|best|biggest|largest|most valuable).*customers?|customers?.*(top|best|most)/i,
    schema: "shop",
    object: "customers",
    ...customersBy("revenue"),
    clarify: {
      question: "Should “top customers” be ranked by revenue or by number of orders?",
      options: ["By revenue", "By number of orders"],
      choose(text) {
        if (/order|purchase|count|number|often|frequen/i.test(text)) return customersBy("orders")
        if (/revenue|spend|spent|sales|value|money|usd/i.test(text)) return customersBy("revenue")
        return null
      },
    },
  },
  {
    matches: /(top|best|most popular).*products?|products?.*(top|best|sell)/i,
    schema: "shop",
    object: "order_items",
    purpose: "Revenue and units by product over the last 90 days",
    label: "Top products by revenue, last 90 days",
    sql: `SELECT p.name, p.category, sum(i.quantity) AS units, sum(i.line_total) AS revenue
  FROM shop.order_items i
  JOIN shop.orders o ON o.id = i.order_id
  JOIN shop.products p ON p.id = i.product_id
 WHERE o.status NOT IN ('cancelled', 'refunded')
   AND o.ordered_at >= now() - interval '90 days'
 GROUP BY p.id, p.name, p.category
 ORDER BY revenue DESC
 LIMIT 5`,
    answer(rows) {
      const top = rows[0]
      return [
        "**Top products by revenue, last 90 days** (orders that were not cancelled or refunded)",
        table(
          ["#", "Product", "Category", "Units", "Revenue (USD)"],
          [true, false, false, true, true],
          rows.map((row, index) => [
            String(index + 1),
            text(row[0]),
            text(row[1]),
            amount(row[2]),
            amount(row[3]),
          ]),
        ),
        `**${text(top?.[0])}** led with ${amount(top?.[3])} USD from ${amount(top?.[2])} units.`,
      ].join("\n\n")
    },
  },
  {
    matches: /refund/i,
    schema: "shop",
    object: "orders",
    purpose: "Refunded share of orders by month for the last 6 months",
    label: "Refund rate by month",
    sql: `SELECT to_char(date_trunc('month', ordered_at), 'YYYY-MM') AS month,
       count(*) FILTER (WHERE status <> 'cancelled') AS orders,
       count(*) FILTER (WHERE status = 'refunded') AS refunded,
       round(100.0 * count(*) FILTER (WHERE status = 'refunded')
             / nullif(count(*) FILTER (WHERE status <> 'cancelled'), 0), 1) AS refund_rate_pct
  FROM shop.orders
 WHERE ordered_at >= date_trunc('month', now()) - interval '5 months'
 GROUP BY 1
 ORDER BY 1`,
    answer(rows) {
      const worst = largest(rows, 3)
      return [
        "**Refund rate by month, last 6 months**: refunded orders as a share of orders that were not cancelled.",
        table(
          ["Month", "Orders", "Refunded", "Refund rate"],
          [false, true, true, true],
          rows.map((row) => [text(row[0]), amount(row[1]), amount(row[2]), `${text(row[3])}%`]),
        ),
        `The highest refund rate was ${text(worst?.[3])}% in ${text(worst?.[0])} (${amount(worst?.[2])} of ${amount(worst?.[1])} orders).`,
      ].join("\n\n")
    },
  },
  {
    matches: /ticket/i,
    schema: "support",
    object: "tickets",
    purpose: "Unresolved support tickets by status and priority",
    label: "Open and pending tickets by priority",
    sql: `SELECT status, priority, count(*) AS tickets
  FROM support.tickets
 WHERE status IN ('open', 'pending')
 GROUP BY status, priority
 ORDER BY status, CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END`,
    answer(rows) {
      const total = (status?: string) =>
        rows.filter((row) => !status || row[0] === status).reduce((sum, row) => sum + Number(row[2]), 0)
      return [
        `**Unresolved support tickets: ${total()}**: ${total("open")} open (waiting for a first response) and ${total("pending")} pending (in progress).`,
        table(
          ["Status", "Priority", "Tickets"],
          [false, false, true],
          rows.map((row) => [text(row[0]), text(row[1]), amount(row[2])]),
        ),
      ].join("\n\n")
    },
  },
  {
    matches: /revenue|sales/i,
    schema: "shop",
    object: "orders",
    purpose: "Net revenue by month for the last 12 months",
    label: "Net revenue by month",
    sql: `SELECT to_char(date_trunc('month', ordered_at), 'YYYY-MM') AS month,
       count(*) AS orders,
       sum(total) AS net_revenue
  FROM shop.orders
 WHERE status NOT IN ('cancelled', 'refunded')
   AND ordered_at >= date_trunc('month', now()) - interval '11 months'
 GROUP BY 1
 ORDER BY 1`,
    answer(rows) {
      const best = largest(rows, 2)
      return [
        "**Net revenue by month, last 12 months**: the amount charged on orders that were not cancelled or refunded, in USD.",
        table(
          ["Month", "Orders", "Net revenue (USD)"],
          [false, true, true],
          rows.map((row) => [text(row[0]), amount(row[1]), amount(row[2])]),
        ),
        `The highest month was ${text(best?.[0])} with ${amount(best?.[2])} USD. The current month is still in progress.`,
      ].join("\n\n")
    },
  },
]

interface ListedSource {
  id: string
  engine: string
  schemas?: string[]
}

interface QueryOutput {
  executionId: string
  rows: Cell[][]
}

function submit(
  markdown: string,
  status: "complete" | "partial",
  evidence: { executionId: string; label: string }[] = [],
  missing: string[] = [],
): ScriptedTurn {
  return {
    calls: [
      {
        name: "submit_answer",
        input: { markdown, status, evidence, ...(missing.length > 0 ? { missing } : {}) },
      },
    ],
  }
}

/**
 * Answers a few fixed questions about the synthetic demo store by calling the
 * real tools with fixed queries, and composes each answer from the rows they
 * return. Anything else gets an honest "I can't".
 */
export function demoScript(view: ScriptView): ScriptedTurn {
  const scenario = SCENARIOS.find((candidate) => candidate.matches.test(view.question))
  if (!scenario)
    return submit(UNSUPPORTED, "partial", [], ["A configured model provider for other questions"])

  const listed = view.last("list_sources")
  if (!listed)
    return { text: "Checking which sources are available. ", calls: [{ name: "list_sources", input: {} }] }
  const sources = listed.ok ? ((listed.output as { sources: ListedSource[] }).sources ?? []) : []
  const source = sources.find(
    (entry) => entry.engine === "postgres" && entry.schemas?.includes(scenario.schema),
  )
  if (!source) {
    return submit(
      `No PostgreSQL source with the synthetic \`${scenario.schema}\` schema is available for this question, so the scripted demo cannot answer it.`,
      "partial",
      [],
      [`A PostgreSQL source with the synthetic ${scenario.schema} schema`],
    )
  }
  let query: DemoQuery = scenario
  if (scenario.clarify) {
    const asked = view.last("ask_user")
    const settled = scenario.clarify.choose(view.question)
    if (!settled && !asked) {
      return {
        text: "This question can be read more than one way. ",
        calls: [
          {
            name: "ask_user",
            input: {
              question: scenario.clarify.question,
              options: scenario.clarify.options,
              allowFreeText: true,
            },
          },
        ],
      }
    }
    const reply = asked?.ok ? String((asked.output as { answer?: unknown }).answer ?? "") : ""
    query = settled ?? scenario.clarify.choose(reply) ?? scenario
  }
  if (!view.last("describe_object")) {
    return {
      text: `Looking up what ${scenario.schema}.${scenario.object} means. `,
      calls: [
        {
          name: "describe_object",
          input: { connectionId: source.id, schema: scenario.schema, name: scenario.object },
        },
      ],
    }
  }
  const ran = view.last("run_query")
  if (!ran) {
    return {
      text: "Running the query. ",
      calls: [
        {
          name: "run_query",
          input: {
            connectionId: source.id,
            query: { language: "sql", sql: query.sql },
            purpose: query.purpose,
          },
        },
      ],
    }
  }
  if (!ran.ok) {
    return submit(
      `The query for this question failed, so there is no answer: ${String(ran.output)}`,
      "partial",
      [],
      ["A successful query result"],
    )
  }
  if (view.results.filter((result) => result.name === "submit_answer").length >= 2) {
    return { text: "The scripted demo could not submit its answer." }
  }
  const result = ran.output as QueryOutput
  const evidence = [{ executionId: result.executionId, label: query.label }]
  if (result.rows.length === 0) {
    return submit(
      `The query returned no rows, so there is nothing to report.\n\n${SIGNATURE}`,
      "partial",
      evidence,
      ["Rows for the period asked about"],
    )
  }
  return submit(`${query.answer(result.rows)}\n\n${SIGNATURE}`, "complete", evidence)
}

export function createDemoModel(): ScriptedProvider {
  return new ScriptedProvider(DEMO_MODEL, demoScript)
}
