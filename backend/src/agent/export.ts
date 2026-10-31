import type { Cell, ReadQuery } from "../queries/schemas.js"
import type { AgentRun, EvidenceItem } from "./contracts.js"

// An answer as a Markdown document: the question, the answer as written,
// what the data could not tell, and each cited query with the rows the
// answer shows. Cells read as they do on screen, with NULL and missing
// fields labelled.

/** A code fence longer than any run of backticks in the text, so the text cannot close it. */
function fenced(text: string, language: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}${language}\n${text}\n${fence}`
}

function queryBlock(query: ReadQuery): string {
  if (query.language === "sql") return fenced(query.sql, "sql")
  const { language: _language, ...rest } = query
  return fenced(JSON.stringify(rest, null, 2), "json")
}

/** A table cell: pipes escaped and line breaks flattened so the row stays one line. */
function tableCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n|\r/g, " ")
}

function cellText(cell: Cell): string {
  if (cell === null) return "NULL"
  if (typeof cell === "object") return "*missing*"
  return String(cell)
}

const rows = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`

function evidenceSection(item: EvidenceItem, index: number, sourceName: string | null): string {
  const lines = [`### ${index + 1}. ${item.label}`, ""]
  lines.push(`Source: ${sourceName ?? "a removed source"} · query run ${item.executionId}`, "")
  lines.push(queryBlock(item.query), "")
  if (item.columns.length > 0) {
    lines.push(`| ${item.columns.map((column) => tableCell(column.name)).join(" | ")} |`)
    lines.push(`| ${item.columns.map(() => "---").join(" | ")} |`)
    for (const row of item.rows) {
      const cells = item.columns.map((_, column) => tableCell(cellText(row[column] ?? null)))
      lines.push(`| ${cells.join(" | ")} |`)
    }
    lines.push("")
  }
  const shown =
    item.rows.length < item.rowCount
      ? `First ${item.rows.length.toLocaleString("en-US")} of ${rows(item.rowCount)}.`
      : `${rows(item.rowCount)}.`
  lines.push(
    item.truncated ? `${shown} The query stopped at its row or size limit, so more rows matched.` : shown,
  )
  return lines.join("\n")
}

/** The run's answer as Markdown; `sourceNames` names the sources its evidence cites. */
export function answerMarkdown(run: AgentRun, sourceNames: ReadonlyMap<string, string>): string {
  const answer = run.answer
  if (!answer) throw new Error("The run has no answer")
  const answered = run.finishedAt ?? run.createdAt
  const partial = answer.status === "partial" ? " · partial answer" : ""
  const sections = [
    `# ${run.question.replace(/\s+/g, " ").trim()}`,
    `Answered ${answered.slice(0, 16).replace("T", " ")} UTC by ${run.model}${partial}`,
    answer.markdown,
  ]
  if (answer.missing.length > 0) {
    const missing = answer.missing.map((item) => `- ${item}`)
    sections.push(["## What the data could not tell", "", ...missing].join("\n"))
  }
  if (answer.evidence.length > 0) {
    sections.push(
      [
        "## Evidence",
        ...answer.evidence.map((item, index) =>
          evidenceSection(item, index, sourceNames.get(item.connectionId) ?? null),
        ),
      ].join("\n\n"),
    )
  }
  return `${sections.join("\n\n")}\n`
}
