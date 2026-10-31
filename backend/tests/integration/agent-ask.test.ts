import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import {
  ACTIVE_RUN_STATUSES,
  type AgentRun,
  type AgentRunWithEvents,
  type ConversationWithRuns,
  type RunEvent,
} from "../../src/agent/contracts.js"
import { createDemoModel } from "../../src/agent/demo-model.js"
import type { ModelProvider } from "../../src/agent/provider.js"
import { AgentRunner } from "../../src/agent/runner.js"
import {
  ScriptedProvider,
  type ScriptedTurn,
  type ScriptView,
  type ToolOutcome,
} from "../../src/agent/scripted.js"
import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import type { Cell } from "../../src/queries/schemas.js"
import { createApp, type AppDeps } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, TestClient } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { openStream } from "./support/sse.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const KEY = randomBytes(32).toString("hex")
const HEARTBEAT_MS = 150
/** About 1.3 KB of CSV with multi-byte characters, so slices must respect character boundaries. */
const CSV = [
  "month,region,net_revenue_eur",
  ...Array.from(
    { length: 40 },
    (_, index) => `2026-${String((index % 12) + 1).padStart(2, "0")},Zürich,${1000 + index}.50`,
  ),
].join("\n")

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: Record<string, unknown> }
}
interface FileSlice {
  fileId: string
  name: string
  content: string
  offset: number
  nextOffset: number | null
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
const runners: AgentRunner[] = []
const apps: RunningApp[] = []
let consoleCapture: ReturnType<typeof captureConsole>
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let globex: Workspace
let source: ReturnType<typeof sourceSettings>
let connection: Connection
/** A second copy of the demo source that now reads only the shop schema. */
let copy: Connection
const prompts: string[] = []
const seen: Record<string, ToolOutcome[]> = {}

const runsPath = (workspace = acme) => `/api/v1/workspaces/${workspace.id}/agent/runs`
const eventsPath = (runId: string, workspace = acme) => `${runsPath(workspace)}/${runId}/events`

const call = (name: string, input: unknown) => ({ name, input })
const submit = (markdown: string): ScriptedTurn => ({
  calls: [call("submit_answer", { markdown, status: "complete", evidence: [] })],
})
const replyTo = (view: ScriptView) => String((view.last("ask_user")?.output as { answer?: string }).answer)
const fileIds = (view: ScriptView) =>
  [...view.question.matchAll(/id: ([0-9a-f-]{36})/g)].map((match) => match[1])

/** Test scenarios, chosen by a [tag] in the question. */
const SCENARIOS: Record<string, (view: ScriptView) => ScriptedTurn> = {
  stream(view) {
    if (view.turn === 0) return { text: "Looking around. ", delayMs: 300, calls: [call("list_sources", {})] }
    return { ...submit("Done."), delayMs: 200 }
  },
  clarify(view) {
    if (view.turn === 0) {
      return {
        calls: [
          call("ask_user", {
            question: "Rank by revenue or by number of orders?",
            options: ["By revenue", "By number of orders"],
            allowFreeText: false,
          }),
        ],
      }
    }
    return submit(`Ranked ${replyTo(view)}.`)
  },
  ask(view) {
    if (view.turn === 0) return { calls: [call("ask_user", { question: "Which month?" })] }
    return submit(`Month: ${replyTo(view)}.`)
  },
  file(view) {
    const [csv] = fileIds(view)
    if (view.turn === 0) {
      return {
        calls: [
          call("read_attachment", { fileId: csv, maxBytes: 500 }),
          call("read_attachment", { fileId: randomUUID() }),
        ],
      }
    }
    const first = view.results[0]?.output as FileSlice
    if (view.turn === 1) {
      return { calls: [call("read_attachment", { fileId: csv, offset: first.nextOffset, maxBytes: 500 })] }
    }
    seen.file = view.results
    return submit(`Read ${first.name}.`)
  },
  followfile(view) {
    if (view.turn === 0) return { calls: [call("read_attachment", { fileId: fileIds(view)[0] })] }
    seen.followfile = view.results
    return submit("Read it again.")
  },
  search(view) {
    if (view.turn === 0) return { calls: [call("search_metadata", { query: "id" })] }
    seen.search = view.results
    return submit("Searched.")
  },
  schemas(view) {
    if (view.turn === 0) {
      return {
        calls: [
          call("describe_object", { connectionId: copy.id, schema: "support", name: "tickets" }),
          call("describe_object", { connectionId: copy.id, schema: "shop", name: "orders" }),
        ],
      }
    }
    seen.schemas = view.results
    return submit("Described.")
  },
  plain: () => submit("Nothing to look up."),
}

const scripted = new ScriptedProvider("test script", (view) => {
  const tag = /\[(\w+)\]/.exec(view.question)?.[1] ?? ""
  const scenario = SCENARIOS[tag]
  if (!scenario) throw new Error(`No test scenario for: ${view.question}`)
  return scenario(view)
})

/** Records the question each turn sees, then answers from the script. */
const recording: ModelProvider = {
  provider: scripted.provider,
  model: scripted.model,
  turn(request) {
    const question = request.messages.findLast((message) => message.role === "user")
    if (question?.role === "user") prompts.push(question.text)
    return scripted.turn(request)
  },
}

async function serve(env: Record<string, string>, deps: AppDeps = {}): Promise<RunningApp> {
  const agents = new AgentRunner()
  runners.push(agents)
  const app = await startApp(
    createApp(
      loadEnv({
        NODE_ENV: "test",
        ALLOW_DEV_LOGIN: "true",
        SESSION_SECRET,
        CONNECTION_ENCRYPTION_KEY: KEY,
        ...env,
      }),
      {
        pool: storage,
        sources,
        refreshes,
        queries,
        agents,
        modelProvider: recording,
        streamHeartbeatMs: HEARTBEAT_MS,
        ...deps,
      },
    ),
  )
  apps.push(app)
  return app
}

async function ask(
  client: TestClient,
  question: string,
  extra: Record<string, unknown> = {},
): Promise<AgentRun> {
  const res = await client.call<Ok<AgentRun>>(runsPath(), { method: "POST", json: { question, ...extra } })
  assert.equal(res.status, 202, res.text)
  return res.body.result
}

async function read(client: TestClient, runId: string): Promise<AgentRunWithEvents> {
  const res = await client.call<Ok<AgentRunWithEvents>>(`${runsPath()}/${runId}`)
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

const finished = (client: TestClient, runId: string) =>
  waitFor(
    () => read(client, runId),
    (run) => !ACTIVE_RUN_STATUSES.includes(run.status),
    `run ${runId} to finish`,
  )

const awaitingInput = (client: TestClient, runId: string) =>
  waitFor(
    () => read(client, runId),
    (run) => run.status === "awaiting_input",
    `run ${runId} to ask its question`,
  )

const answer = (client: TestClient, runId: string, reply: string, options: { csrf?: boolean } = {}) =>
  client.call<Ok<AgentRunWithEvents> & Failure>(`${runsPath()}/${runId}/answer`, {
    method: "POST",
    json: { answer: reply },
    ...options,
  })

const file = (name: string, content: string | Buffer) => ({
  name,
  content: Buffer.from(content).toString("base64"),
})

const seqs = (events: RunEvent[]) => events.map((event) => event.seq)

async function saveSource(name: string): Promise<Connection> {
  const saved = await owner.call<Ok<Connection>>(`/api/v1/workspaces/${acme.id}/connections`, {
    method: "POST",
    json: {
      name,
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop", "support"],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  const reads = manifestClient(
    owner,
    `/api/v1/workspaces/${acme.id}/connections/${saved.body.result.id}/manifest`,
  )
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
  return saved.body.result
}

before(async () => {
  if (skip) return
  storage = createPool(TEST_DATABASE_URL as string)
  await resetStorage(storage)
  sourcePool = createPool(TEST_SOURCE_DATABASE_URL as string)
  await buildDemoSource(sourcePool)
  source = sourceSettings(TEST_SOURCE_DATABASE_URL as string)

  consoleCapture = captureConsole()
  sources = createSourceAdapters()
  refreshes = new RefreshRunner()
  queries = new QueryRunner()
  const main = await serve({ AGENT_MAX_STEPS: "6", AGENT_RUN_TIMEOUT_MS: "60000" })

  const ownerSession = await signIn(main.baseUrl, "owner@example.com", "Owner")
  owner = ownerSession.client
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201, created.text)
  acme = created.body.result
  globex = (
    await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
      method: "POST",
      json: { name: "Globex", slug: "globex" },
    })
  ).body.result
  const memberSession = await signIn(main.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(main.baseUrl, "outsider@example.com", "Outsider")).client

  connection = await saveSource("Demo store (synthetic)")
  copy = await saveSource("Store copy")
  // The copy stops reading support; its published support metadata stays stored.
  await storage.query("UPDATE connections SET selected_schemas = '{shop}' WHERE id = $1", [copy.id])
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  for (const app of apps) await app.close()
  for (const runner of runners) await runner.shutdown()
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test(
  "a run's events stream as they happen, replay from a sequence or Last-Event-ID, and end after the terminal event",
  { skip },
  async () => {
    const run = await ask(owner, "Show me progress [stream]")
    const live = await openStream(owner, eventsPath(run.id))
    assert.equal(live.response.status, 200)
    assert.match(live.response.headers.get("content-type") ?? "", /^text\/event-stream/)
    assert.match(live.response.headers.get("cache-control") ?? "", /no-cache/)
    assert.equal(live.response.headers.get("x-accel-buffering"), "no")
    await live.until((reader) => reader.events().length > 0, "the first event")
    assert.equal((await read(owner, run.id)).status, "running", "the first event arrives while the run works")
    await live.until((reader) => reader.ended, "the stream to end")

    const stored = (await finished(owner, run.id)).events
    assert.equal(live.frames[0]?.retry, "2000")
    assert.deepEqual(live.events(), stored, "live events match the stored ones")
    assert.deepEqual(
      live.frames.flatMap((frame) => (frame.id ? [Number(frame.id)] : [])),
      seqs(stored),
    )
    assert.deepEqual(
      seqs(stored),
      stored.map((_, index) => index + 1),
    )
    assert.equal(stored.at(-1)?.type, "answer.completed")
    assert.ok(stored.some((event) => event.type === "answer.delta" && event.data.text === "Looking around. "))

    const replay = await openStream(owner, `${eventsPath(run.id)}?after=2`)
    await replay.until((reader) => reader.ended, "the replay to end")
    assert.deepEqual(seqs(replay.events<RunEvent>()), seqs(stored).slice(2))

    // A reconnecting EventSource sends the last id it saw; it wins over the original ?after.
    const resumed = await openStream(owner, `${eventsPath(run.id)}?after=1`, { "Last-Event-ID": "4" })
    await resumed.until((reader) => reader.ended, "the resumed stream to end")
    assert.deepEqual(seqs(resumed.events<RunEvent>()), seqs(stored).slice(4))
    // A Last-Event-ID no sequence can have is ignored rather than failing the request.
    const bogus = await openStream(owner, `${eventsPath(run.id)}?after=3`, { "Last-Event-ID": "99999999999" })
    assert.equal(bogus.response.status, 200)
    await bogus.until((reader) => reader.ended, "the stream with a bogus Last-Event-ID to end")
    assert.deepEqual(seqs(bogus.events<RunEvent>()), seqs(stored).slice(3))

    const caughtUp = await openStream(owner, `${eventsPath(run.id)}?after=${stored.length}`)
    await caughtUp.until((reader) => reader.ended, "the caught-up stream to end")
    assert.deepEqual(caughtUp.events(), [])
  },
)

test(
  "a clarification pauses the run until its owner answers; the stream delivers both live",
  { skip },
  async () => {
    const run = await ask(owner, "Who are the top customers? [clarify]")
    const stream = await openStream(owner, eventsPath(run.id))
    await stream.until(
      (reader) => reader.events().some((event) => event.type === "clarification.requested"),
      "the clarification",
    )
    const waiting = await awaitingInput(owner, run.id)
    const expiresAt = Date.parse(waiting.clarification?.expiresAt ?? "")
    assert.ok(
      expiresAt > Date.now() + 25 * 60_000,
      "the answer is awaited for AGENT_ANSWER_TIMEOUT_MS (30 minutes)",
    )
    assert.deepEqual(
      { ...waiting.clarification, id: undefined, expiresAt: undefined },
      {
        id: undefined,
        expiresAt: undefined,
        question: "Rank by revenue or by number of orders?",
        options: ["By revenue", "By number of orders"],
        allowFreeText: false,
      },
    )
    assert.equal(stream.ended, false)

    const notOffered = await answer(owner, run.id, "By margin")
    assert.equal(notOffered.status, 422, notOffered.text)
    assert.deepEqual(notOffered.body.error.details, { options: ["By revenue", "By number of orders"] })
    assert.equal((await answer(member, run.id, "By revenue")).status, 404)
    assert.equal((await answer(outsider, run.id, "By revenue")).status, 404)
    assert.equal((await answer(owner, run.id, "By revenue", { csrf: false })).status, 403)
    assert.equal((await answer(owner, run.id, "   ")).status, 422)

    const answered = await answer(owner, run.id, "By revenue")
    assert.equal(answered.status, 200, answered.text)
    assert.notEqual(answered.body.result.status, "awaiting_input")
    assert.equal(answered.body.result.clarification, null)
    const reply = answered.body.result.events.find((event) => event.type === "clarification.answered")
    assert.deepEqual(reply?.data, { id: waiting.clarification?.id, answer: "By revenue" })
    assert.equal((await answer(owner, run.id, "By revenue")).status, 409, "only one answer is taken")

    await stream.until((reader) => reader.ended, "the stream to end")
    const done = await finished(owner, run.id)
    assert.equal(done.status, "completed")
    assert.equal(done.answer?.markdown, "Ranked By revenue.")
    assert.deepEqual(
      done.events.map((event) => event.type),
      [
        "run.started",
        "tool.started",
        "clarification.requested",
        "clarification.answered",
        "tool.finished",
        "tool.started",
        "tool.finished",
        "answer.completed",
      ],
    )
    assert.deepEqual(stream.events(), done.events)
    const asked = done.events[1]
    assert.ok(asked?.type === "tool.started")
    assert.equal(asked.data.summary, "Asking you: Rank by revenue or by number of orders?")
    const later = await answer(owner, run.id, "By revenue")
    assert.equal(later.status, 409)
    assert.equal(later.body.error.code, "CONFLICT")
  },
)

test(
  "cancelling a run that waits for an answer stops it and ends its stream; heartbeats keep an idle stream open",
  { skip },
  async () => {
    const run = await ask(owner, "Revenue for a month [ask]")
    const stream = await openStream(owner, eventsPath(run.id))
    await stream.until(
      (reader) =>
        reader.frames.some((frame) => frame.comment === "heartbeat") &&
        reader.events().some((event) => event.type === "clarification.requested"),
      "a heartbeat while waiting",
    )
    // A comment for proxies and a named event a browser can watch for, never with an id.
    assert.deepEqual(
      stream.frames.find((frame) => frame.comment === "heartbeat"),
      { comment: "heartbeat", event: "heartbeat", data: "{}" },
    )
    const cancelled = await owner.call<Ok<AgentRunWithEvents>>(`${runsPath()}/${run.id}/cancel`, {
      method: "POST",
    })
    assert.equal(cancelled.status, 200, cancelled.text)
    assert.equal(cancelled.body.result.status, "cancelled")
    assert.equal(cancelled.body.result.clarification, null)
    assert.equal(cancelled.body.result.events.at(-1)?.type, "run.cancelled")
    await stream.until((reader) => reader.ended, "the stream to end")
    assert.equal(stream.events<RunEvent>().at(-1)?.type, "run.cancelled")
    assert.equal((await answer(owner, run.id, "September")).status, 409)
    // The conversation is free for its next question.
    await ask(owner, "Something else [plain]", { conversationId: run.conversationId })
  },
)

test("a stream stops following its run when the client leaves", { skip }, async () => {
  const run = await ask(owner, "Leave midway [ask]")
  const stream = await openStream(owner, eventsPath(run.id))
  await stream.until(
    (reader) => reader.events().some((event) => event.type === "clarification.requested"),
    "the clarification",
  )
  const runner = runners[0]
  assert.ok(runner)
  assert.equal(runner.events.followers(run.id), 1)
  stream.close()
  await waitFor(
    async () => runner.events.followers(run.id),
    (count) => count === 0,
    "the stream to stop following",
  )
  assert.equal((await owner.call(`${runsPath()}/${run.id}/cancel`, { method: "POST" })).status, 200)
})

test(
  "streams follow the run's access rules: other users, non-members, and other workspaces get 404",
  { skip },
  async () => {
    const run = await ask(owner, "Private progress [plain]")
    await finished(owner, run.id)
    assert.equal((await member.call(eventsPath(run.id))).status, 404)
    assert.equal((await outsider.call(eventsPath(run.id))).status, 404)
    assert.equal((await owner.call(eventsPath(run.id, globex))).status, 404)
    assert.equal((await owner.call(eventsPath(randomUUID()))).status, 404)
    assert.equal((await owner.call(`${runsPath()}/not-a-run/events`)).status, 422)
    assert.equal((await new TestClient(owner.baseUrl).call(eventsPath(run.id))).status, 401)
    assert.equal((await owner.call(`${eventsPath(run.id)}?after=-1`)).status, 422)
  },
)

test(
  "the run's clock pauses while it waits for an answer, and an unanswered clarification times out",
  { skip },
  async () => {
    const strict = await serve({ AGENT_RUN_TIMEOUT_MS: "1000", AGENT_ANSWER_TIMEOUT_MS: "2500" })
    const client = owner.at(strict.baseUrl)
    const patient = await ask(client, "Take your time [ask]")
    await awaitingInput(client, patient.id)
    await sleep(1_300)
    assert.equal((await answer(client, patient.id, "September")).status, 200)
    const done = await finished(client, patient.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    assert.equal(done.answer?.markdown, "Month: September.")

    const ignored = await ask(client, "Nobody answers [ask]")
    const failed = await finished(client, ignored.id)
    assert.equal(failed.status, "failed")
    assert.equal(failed.error?.code, "AGENT_INPUT_TIMEOUT")
    assert.match(failed.error?.message ?? "", /No reply to the clarification arrived within 3 seconds/)
    assert.equal(failed.clarification, null)
  },
)

test(
  "files sent with a question are stored, listed, and read in bounded slices for the rest of the conversation",
  { skip },
  async () => {
    const run = await ask(owner, "Summarize the attached revenue [file]", {
      attachments: [file("revenue.csv", CSV), file("notes.md", "# Notes\nEUR, not USD.")],
    })
    assert.deepEqual(
      run.attachments.map(({ name, mediaType, sizeBytes }) => [name, mediaType, sizeBytes]),
      [
        ["revenue.csv", "text/csv", Buffer.byteLength(CSV)],
        ["notes.md", "text/markdown", Buffer.byteLength("# Notes\nEUR, not USD.")],
      ],
    )
    const done = await finished(owner, run.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    assert.deepEqual(done.attachments, run.attachments)
    assert.ok(!JSON.stringify(done).includes("Zürich"), "runs list files without their content")

    const question = prompts.find((prompt) => prompt.includes("[file]")) ?? ""
    assert.match(question, /Files attached in this conversation \(read them with read_attachment\):/)
    assert.match(
      question,
      new RegExp(
        `- revenue\\.csv \\(id: ${run.attachments[0]?.id}; text/csv; [\\d,]+ bytes\\) — attached with this question`,
      ),
    )

    const [first, unknown, second] = seen.file ?? []
    const head = first?.output as FileSlice
    assert.equal(head.offset, 0)
    assert.ok(Buffer.byteLength(head.content) <= 500)
    assert.equal(head.nextOffset, Buffer.byteLength(head.content))
    assert.equal(unknown?.ok, false)
    assert.match(String(unknown?.output), /No file with this id was attached in this conversation/)
    const next = second?.output as FileSlice
    assert.equal(next.offset, head.nextOffset)
    assert.ok(CSV.startsWith(head.content + next.content), "slices join up without broken characters")
    assert.ok(!(head.content + next.content).includes("�"))

    const followUp = await ask(owner, "Read it once more [followfile]", {
      conversationId: run.conversationId,
    })
    assert.deepEqual(followUp.attachments, [])
    assert.equal((await finished(owner, followUp.id)).status, "completed")
    const again = seen.followfile?.[0]?.output as FileSlice
    assert.equal(again.name, "revenue.csv")
    assert.equal(again.nextOffset, null, "a small file is read whole by default")
    const later = prompts.findLast((prompt) => prompt.includes("[followfile]")) ?? ""
    assert.match(later, /- revenue\.csv \(id: [^)]+\)\n/, "earlier files are listed without the marker")
  },
)

test(
  "questions take at most three text files of 256 KB in UTF-8; only questions get the larger body limit",
  { skip },
  async () => {
    const refused = async (attachments: unknown[]) => {
      const res = await owner.call<Failure>(runsPath(), {
        method: "POST",
        json: { question: "Files [plain]", attachments },
      })
      assert.equal(res.status, 422, res.text)
      assert.equal(res.body.error.code, "VALIDATION_FAILED")
      return res.body.error
    }
    await refused([1, 2, 3, 4].map((index) => file(`f${index}.txt`, "x")))
    const xlsx = await refused([file("ok.csv", "a,b"), file("report.xlsx", "PK")])
    assert.match(xlsx.message, /“report\.xlsx” is not a text or CSV file/)
    assert.deepEqual(xlsx.details, {
      attachments: [{ index: 1, message: xlsx.message }],
    })
    assert.match(
      (await refused([file("latin1.csv", Buffer.from([0x63, 0x61, 0x66, 0xe9]))])).message,
      /not UTF-8/,
    )
    await refused([file("big.txt", "x".repeat(256 * 1024 + 3))])
    await refused([{ name: "plain.txt", content: "not base64!" }])

    const largest = await ask(owner, "Three full files [plain]", {
      attachments: ["a", "b", "c"].map((name) => file(`${name}.txt`, name.repeat(256 * 1024))),
    })
    assert.deepEqual(
      largest.attachments.map((attachment) => attachment.sizeBytes),
      [262144, 262144, 262144],
    )
    await finished(owner, largest.id)

    const tooLarge = await owner.call<Failure>(`/api/v1/workspaces/${acme.id}/knowledge`, {
      method: "POST",
      json: { title: "Big", body: "x".repeat(1_100_000) },
    })
    assert.equal(tooLarge.status, 413, "other routes keep the 1 MB body limit")
  },
)

test(
  "a conversation reads back with its runs, oldest first; finished runs leave out the text streamed while working",
  { skip },
  async () => {
    const opening = await ask(owner, "Show me progress again [stream]")
    await finished(owner, opening.id)
    const followUp = await ask(owner, "And now? [plain]", { conversationId: opening.conversationId })
    await finished(owner, followUp.id)

    const path = `/api/v1/workspaces/${acme.id}/agent/conversations/${opening.conversationId}`
    const res = await owner.call<Ok<ConversationWithRuns>>(path)
    assert.equal(res.status, 200, res.text)
    const conversation = res.body.result
    assert.equal(conversation.id, opening.conversationId)
    assert.equal(conversation.title, "Show me progress again [stream]")
    assert.deepEqual(
      conversation.runs.map((run) => run.id),
      [opening.id, followUp.id],
    )
    const [first] = conversation.runs
    assert.equal(first?.answer?.markdown, "Done.")
    assert.ok(first?.events.some((event) => event.type === "answer.completed"))
    assert.ok(!first?.events.some((event) => event.type === "answer.delta"))

    assert.equal((await member.call(path)).status, 404)
    assert.equal((await outsider.call(path)).status, 404)
    assert.equal(
      (await owner.call(`/api/v1/workspaces/${acme.id}/agent/conversations/${randomUUID()}`)).status,
      404,
    )
  },
)

test(
  "search_metadata counts only the run's sources toward its hit limit; describe_object refuses schemas a source no longer reads",
  { skip },
  async () => {
    await finished(
      owner,
      (await ask(owner, "Where are ids? [search]", { connectionIds: [connection.id] })).id,
    )
    const hits = seen.search?.[0]?.output as {
      objects: { connectionId: string }[]
      columns: { connectionId: string }[]
    }
    assert.equal(hits.columns.length, 10, "the limit is filled from the run's own source")
    assert.ok(hits.columns.every((hit) => hit.connectionId === connection.id))
    assert.ok(hits.objects.every((hit) => hit.connectionId === connection.id))

    await finished(owner, (await ask(owner, "Describe the copy [schemas]")).id)
    const [support, shop] = seen.schemas ?? []
    assert.equal(support?.ok, false)
    assert.match(
      String(support?.output),
      /support\.tickets is in schema support, which this source no longer reads \(it reads shop\)/,
    )
    assert.equal(shop?.ok, true)
  },
)

test(
  "the scripted demo model asks what “top customers” means and answers from a real query",
  { skip },
  async () => {
    const demo = await serve({}, { modelProvider: createDemoModel() })
    const client = owner.at(demo.baseUrl)
    const run = await ask(client, "Who are our top customers?")
    const waiting = await awaitingInput(client, run.id)
    assert.deepEqual(waiting.clarification?.options, ["By revenue", "By number of orders"])
    assert.equal(waiting.model, "demo (synthetic)")
    assert.equal((await answer(client, run.id, "By number of orders")).status, 200)
    const done = await finished(client, run.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    const [evidence] = done.answer?.evidence ?? []
    assert.ok(evidence && evidence.query.language === "sql")
    assert.match(evidence.query.sql, /ORDER BY orders DESC, revenue DESC/)
    const direct = await sourcePool.query<Cell[]>({ text: evidence.query.sql, rowMode: "array" })
    assert.deepEqual(evidence.rows, direct.rows)
    assert.match(done.answer?.markdown ?? "", /\*\*Top customers by number of orders\*\*/)
  },
)

test("passwords never appear in responses or console output", { skip }, () => {
  for (const text of [...owner.responses, ...member.responses, ...consoleCapture.lines]) {
    assert.ok(!text.includes(source.password), "the source password leaked")
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
