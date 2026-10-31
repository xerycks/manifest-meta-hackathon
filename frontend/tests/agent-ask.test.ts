import assert from "node:assert/strict"
import test from "node:test"

import { addFiles, ATTACHMENT_ACCEPT, encodeFile, formatBytes } from "../src/entities/agent/attachments.ts"
import { queryKind, queryText } from "../src/entities/queries/query-text.ts"
import { announcement, describeAskError, modelLabel } from "../src/features/chat-panel/chat-text.ts"
import { ApiError } from "../src/shared/api/client.ts"

const picked = (name: string, size: number) => ({ name, size })

test("files are checked against the limits as they are attached", () => {
  assert.equal(ATTACHMENT_ACCEPT, ".csv,.tsv,.txt,.md,.json")
  const { files, problems } = addFiles(
    [picked("a.csv", 10)],
    [
      picked("b.TXT", 20),
      picked("report.xlsx", 5),
      picked("empty.md", 0),
      picked("huge.csv", 256 * 1024 + 1),
      picked("c.json", 30),
      picked("d.tsv", 40),
    ],
  )
  assert.deepEqual(
    files.map((file) => file.name),
    ["a.csv", "b.TXT", "c.json"],
  )
  assert.deepEqual(problems, [
    "“report.xlsx” is not a text or CSV file.",
    "“empty.md” is empty.",
    "“huge.csv” is larger than 256 KB.",
    "Attach at most 3 files; “d.tsv” was left out.",
  ])
  const again = addFiles([picked("a.csv", 10)], [picked("a.csv", 10), picked("a.csv", 11)])
  assert.deepEqual(
    again.files.map((file) => file.size),
    [10, 11],
    "a file of the same name but other content is a different file",
  )
  assert.deepEqual(again.problems, ["“a.csv” is already attached."])
  assert.equal(formatBytes(1), "1 byte")
  assert.equal(formatBytes(980), "980 bytes")
  assert.equal(formatBytes(12_700), "12.4 KB")
})

test("a file is sent as base64 of its exact bytes", async () => {
  const file = new File(["month,total\n2026-09,€12.50\n"], "sales.csv", { type: "text/csv" })
  const encoded = await encodeFile(file)
  assert.equal(encoded.name, "sales.csv")
  assert.equal(Buffer.from(encoded.content, "base64").toString("utf8"), "month,total\n2026-09,€12.50\n")
})

test("queries read as written: SQL as is, MongoDB as indented JSON without the language", () => {
  assert.equal(queryText({ language: "sql", sql: "SELECT 1" }), "SELECT 1")
  assert.equal(queryKind({ language: "sql", sql: "SELECT 1" }), "SQL")
  const mongo = {
    language: "mongodb" as const,
    database: "shop",
    collection: "orders",
    operation: "aggregate" as const,
    pipeline: [{ $match: { total: { $numberDecimal: "12.50" } } }],
  }
  assert.equal(queryKind(mongo), "MongoDB aggregate")
  assert.deepEqual(JSON.parse(queryText(mongo)), {
    database: "shop",
    collection: "orders",
    operation: "aggregate",
    pipeline: [{ $match: { total: { $numberDecimal: "12.50" } } }],
  })
  assert.match(queryText(mongo), /\n {2}"database": "shop"/)
})

test("the model is named, and the scripted demo model is always marked synthetic", () => {
  assert.equal(modelLabel({ provider: "anthropic", model: "claude-opus-5-5" }), "claude-opus-5-5")
  assert.equal(modelLabel({ provider: "scripted", model: "demo (synthetic)" }), "demo (synthetic)")
  assert.equal(modelLabel({ provider: "scripted", model: "test script" }), "test script (synthetic)")
})

test("refused questions explain why, using the server's validation details", () => {
  const busy = new ApiError(429, "AGENT_BUSY", "You already have two questions being answered.")
  assert.deepEqual(describeAskError(busy), {
    title: "Too many questions at once",
    message: "You already have two questions being answered.",
  })
  const files = new ApiError(422, "VALIDATION_FAILED", "“a.xlsx” is not a text or CSV file.", undefined, {
    attachments: [{ index: 0, message: "“a.xlsx” is not a text or CSV file." }],
  })
  assert.deepEqual(describeAskError(files), {
    title: "Check your question",
    message: "“a.xlsx” is not a text or CSV file.",
  })
  const conflict = new ApiError(409, "CONFLICT", "This question is not waiting for an answer.")
  assert.equal(describeAskError(conflict, "send your answer").title, "Could not send your answer")
  assert.equal(
    describeAskError(new Error("Cannot reach the Manifest API.")).message,
    "Cannot reach the Manifest API.",
  )
})

test("screen readers hear when an answer is ready, input is needed, or a question ends", () => {
  assert.equal(
    announcement("completed", "**Ada** ranks first with [12 orders](#)."),
    "Answer ready: Ada ranks first with 12 orders.",
  )
  assert.equal(
    announcement("completed", "| Month | Orders |\n| --- | ---: |\n| 2026-09 | 12 |"),
    "Answer ready: Month Orders 2026-09 12",
  )
  assert.equal(announcement("awaiting_input", null), "The question needs your answer to continue.")
  assert.equal(announcement("failed", null), "The question could not be answered.")
  assert.equal(announcement("running", null), null)
})
