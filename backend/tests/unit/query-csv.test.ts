import assert from "node:assert/strict"
import test from "node:test"

import { answerMarkdown } from "../../src/agent/export.js"
import type { AgentRun } from "../../src/agent/contracts.js"
import { cellText, csvField, resultCsv } from "../../src/queries/csv.js"
import { MISSING, type ResultColumn } from "../../src/queries/schemas.js"

const column = (name: string, kind: ResultColumn["kind"] = "text"): ResultColumn => ({ name, type: kind, kind })

test("CSV starts with a UTF-8 BOM and ends every record with CRLF, columns in result order", () => {
  const csv = resultCsv({
    columns: [column("id", "integer"), column("id", "integer"), column("name")],
    rows: [
      [1, 10, "Ava"],
      [2, 20, "Kai"],
    ],
  })
  assert.equal(csv, "\uFEFFid,id,name\r\n1,10,Ava\r\n2,20,Kai\r\n")
  assert.equal(resultCsv({ columns: [column("n")], rows: [] }), "\uFEFFn\r\n")
})

test("fields with quotes, commas, and line breaks are quoted, with quotes doubled", () => {
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField("a,b"), '"a,b"')
  assert.equal(csvField("line one\nline two"), '"line one\nline two"')
  assert.equal(csvField("line one\r\nline two"), '"line one\r\nline two"')
  assert.equal(csvField("plain text"), "plain text")
  assert.equal(csvField(" padded "), " padded ")
  assert.equal(csvField("{\"a\":1}"), '"{""a"":1}"')
})

test("text a spreadsheet would run as a formula is neutralized; plain numbers are not", () => {
  assert.equal(csvField("=SUM(A1:A9)"), "'=SUM(A1:A9)")
  assert.equal(csvField("+1+cmd|' /C calc'!A0"), "'+1+cmd|' /C calc'!A0")
  assert.equal(csvField("-2+3"), "'-2+3")
  assert.equal(csvField("@SUM(1)"), "'@SUM(1)")
  assert.equal(csvField("\tTAB"), "'\tTAB")
  assert.equal(csvField("\rCR"), "\"'\rCR\"")
  assert.equal(csvField('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`)
  assert.equal(csvField("-Infinity"), "'-Infinity")
  for (const number of ["-12.50", "+7", "-0.000001", "-1e-7", "12345678901234567890.12", "-.5"]) {
    assert.equal(csvField(number), number)
  }
  assert.equal(csvField("a=b"), "a=b")
})

test("cells keep their exact text; NULL and missing MongoDB fields are both empty", () => {
  assert.equal(cellText("12345678901234567890.12"), "12345678901234567890.12")
  assert.equal(cellText("9223372036854775807"), "9223372036854775807")
  assert.equal(cellText(42), "42")
  assert.equal(cellText(0.1), "0.1")
  assert.equal(cellText(true), "true")
  assert.equal(cellText(false), "false")
  assert.equal(cellText("2026-10-31T09:30:00.123456Z"), "2026-10-31T09:30:00.123456Z")
  assert.equal(cellText(null), "")
  assert.equal(cellText(MISSING), "")
  assert.equal(cellText(""), "")
  const csv = resultCsv({
    columns: [column("total", "decimal"), column("email"), column("note")],
    rows: [
      ["-12.50", null, MISSING],
      ["0.01", "", "=1+1"],
    ],
  })
  assert.equal(csv, "\uFEFFtotal,email,note\r\n-12.50,,\r\n0.01,,'=1+1\r\n")
})

test("an answer exports as Markdown with its evidence queries and rows", () => {
  const run: AgentRun = {
    id: "4b4f7f0e-1d0b-4a43-8d0e-6a3a1f0b9c11",
    conversationId: "c5c8f3a1-6b8e-4f0f-9d43-0a1b2c3d4e5f",
    userId: "u",
    question: "What was  net revenue\nby month?",
    connectionIds: [],
    status: "completed",
    provider: "scripted",
    model: "demo (synthetic)",
    answer: {
      markdown: "Net revenue rose in **October**.",
      status: "partial",
      missing: ["Refunds before 2025"],
      evidence: [
        {
          executionId: "e1",
          connectionId: "source-1",
          label: "Monthly net revenue",
          query: { language: "sql", sql: "SELECT '```' AS fence, month, revenue FROM t" },
          columns: [column("fence"), column("month | label"), column("revenue", "decimal")],
          rows: [
            ["```", "2026-10\nOctober", "1200.50"],
            [null, MISSING, "-3.00"],
          ],
          rowCount: 40,
          truncated: true,
        },
      ],
    },
    error: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: 2,
    clarification: null,
    attachments: [],
    disposition: null,
    retryOf: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    startedAt: "2026-10-31T09:00:00.000Z",
    finishedAt: "2026-10-31T09:00:05.000Z",
  }
  const markdown = answerMarkdown(run, new Map([["source-1", "Demo store (synthetic)"]]))
  assert.ok(
    markdown.startsWith(
      "# What was net revenue by month?\n\n" +
        "Answered 2026-10-31 09:00 UTC by demo (synthetic) · partial answer\n\n" +
        "Net revenue rose in **October**.",
    ),
  )
  assert.match(markdown, /## What the data could not tell\n\n- Refunds before 2025/)
  assert.match(markdown, /### 1\. Monthly net revenue\n\nSource: Demo store \(synthetic\) · query run e1/)
  // The SQL holds a triple backtick, so its fence is longer.
  assert.match(markdown, /````sql\nSELECT '```' AS fence, month, revenue FROM t\n````/)
  assert.match(markdown, /\| fence \| month \\\| label \| revenue \|\n\| --- \| --- \| --- \|/)
  assert.match(markdown, /\| ``` \| 2026-10 October \| 1200\.50 \|\n\| NULL \| \*missing\* \| -3\.00 \|/)
  assert.match(markdown, /First 2 of 40 rows\. The query stopped at its row or size limit/)
  assert.ok(markdown.endsWith("\n"))
})
