import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import test, { after, before } from "node:test"

import type { Pool } from "pg"

import {
  ACTIVE_RUN_STATUSES,
  type AgentRun,
  type AgentRunWithEvents,
  type ConversationPage,
  type ConversationWithRuns,
  type RunEvent,
} from "../../src/agent/contracts.js"
import { AgentRunsRepository } from "../../src/agent/repository.js"
import { AgentRunner } from "../../src/agent/runner.js"
import { ScriptedProvider, type ScriptedTurn, type ScriptView } from "../../src/agent/scripted.js"
import { loadEnv } from "../../src/config/env.js"
import { closeSourceAdapters, createSourceAdapters } from "../../src/connections/adapters/index.js"
import type { SourceAdapters } from "../../src/connections/adapters/types.js"
import type { Connection } from "../../src/connections/repository.js"
import { RefreshRunner } from "../../src/manifests/runner.js"
import { QueryRunner } from "../../src/queries/runner.js"
import { createApp } from "../../src/server/app.js"
import { createPool } from "../../src/shared/postgres/client.js"
import { buildDemoSource } from "../../src/storage/demo-source-builder.js"
import { WorkspacesRepository, type Workspace } from "../../src/workspaces/repository.js"
import { captureConsole } from "./support/console.js"
import { signIn, type TestClient } from "./support/http.js"
import { manifestClient, waitFor } from "./support/manifests.js"
import { startApp, type RunningApp } from "./support/server.js"
import { sourceSettings } from "./support/source.js"
import { openStream, type SseReader } from "./support/sse.js"
import { resetStorage } from "./support/storage.js"

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL
const TEST_SOURCE_DATABASE_URL = process.env.TEST_SOURCE_DATABASE_URL
const skip = !TEST_DATABASE_URL || !TEST_SOURCE_DATABASE_URL
const SESSION_SECRET = "integration-test-secret-at-least-32-chars"
const KEY = randomBytes(32).toString("hex")

interface Ok<T> {
  result: T
}
interface Failure {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

/** One backend process: an app and the runner holding its runs. */
interface Backend {
  app: RunningApp
  runner: AgentRunner
}

let storage: Pool
let sourcePool: Pool
let sources: SourceAdapters
let refreshes: RefreshRunner
let queries: QueryRunner
const backends: Backend[] = []
let consoleCapture: ReturnType<typeof captureConsole>
let main: Backend
let owner: TestClient
let member: TestClient
let outsider: TestClient
let acme: Workspace
let source: ReturnType<typeof sourceSettings>
let connection: Connection

const agentPath = (sub = "") => `/api/v1/workspaces/${acme.id}/agent${sub}`
const runPath = (runId: string, sub = "") => agentPath(`/runs/${runId}${sub}`)

const call = (name: string, input: unknown) => ({ name, input })
const executionOf = (view: ScriptView) =>
  String((view.last("run_query")?.output as { executionId?: string } | undefined)?.executionId)
const countOrders = () =>
  call("run_query", {
    connectionId: connection.id,
    query: { language: "sql", sql: "SELECT count(*) AS orders FROM shop.orders" },
    purpose: "Count orders",
  })
const submit = (markdown: string, evidence: { executionId: string; label: string }[] = []): ScriptedTurn => ({
  calls: [call("submit_answer", { markdown, status: "complete", evidence })],
})

/** Test scenarios, chosen by a [tag] in the question. */
const SCENARIOS: Record<string, (view: ScriptView) => ScriptedTurn> = {
  plain: () => submit("Nothing to look up."),
  stream(view) {
    if (view.turn === 0) return { text: "Looking around. ", delayMs: 300, calls: [call("list_sources", {})] }
    return { ...submit("Done."), delayMs: 300 }
  },
  slow(view) {
    if (view.turn === 0) return { delayMs: 1_500, calls: [call("list_sources", {})] }
    return submit("Finally.")
  },
  // A query, then a question, then an answer citing the query run before the question.
  clarify(view) {
    if (view.turn === 0) return { calls: [countOrders()] }
    if (view.turn === 1) {
      return {
        calls: [
          call("ask_user", {
            question: "Count all orders or only paid ones?",
            options: ["All orders", "Paid only"],
            allowFreeText: false,
          }),
        ],
      }
    }
    const reply = (view.last("ask_user")?.output as { answer: string }).answer
    return submit(`Counted ${reply.toLowerCase()} after ${view.results[0]?.name}.`, [
      { executionId: executionOf(view), label: "Orders" },
    ])
  },
  ask(view) {
    if (view.turn === 0) return { calls: [call("ask_user", { question: "Which month?" })] }
    return submit("Noted.")
  },
  evidence(view) {
    if (view.turn === 0) return { calls: [countOrders()] }
    return submit("Counted.", [{ executionId: executionOf(view), label: "Orders" }])
  },
}

const scripted = new ScriptedProvider("test script", (view) => {
  const tag = /\[(\w+)\]/.exec(view.question)?.[1] ?? ""
  const scenario = SCENARIOS[tag]
  if (!scenario) throw new Error(`No test scenario for: ${view.question}`)
  return scenario(view)
})

/** Starts a backend process on the shared storage, as after a (re)start. */
async function serve(env: Record<string, string> = {}): Promise<Backend> {
  const runner = new AgentRunner()
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
        agents: runner,
        modelProvider: scripted,
        streamHeartbeatMs: 150,
      },
    ),
  )
  const backend = { app, runner }
  backends.push(backend)
  return backend
}

/** The owner's browser session, talking to this backend process. */
const clientOf = (backend: Backend) => owner.at(backend.app.baseUrl)

/** Stops a backend process the way SIGTERM does: runs stop, then the server closes. */
async function stop(backend: Backend): Promise<void> {
  await backend.runner.shutdown()
  await backend.app.close()
}

async function ask(
  client: TestClient,
  question: string,
  extra: Record<string, unknown> = {},
): Promise<AgentRun> {
  const res = await client.call<Ok<AgentRun>>(agentPath("/runs"), {
    method: "POST",
    json: { question, ...extra },
  })
  assert.equal(res.status, 202, res.text)
  return res.body.result
}

async function read(client: TestClient, runId: string, after = 0): Promise<AgentRunWithEvents> {
  const res = await client.call<Ok<AgentRunWithEvents>>(runPath(runId, `?after=${after}`))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

const until = (
  client: TestClient,
  runId: string,
  ready: (run: AgentRunWithEvents) => boolean,
  label: string,
) => waitFor(() => read(client, runId), ready, label)

const finished = (client: TestClient, runId: string) =>
  until(client, runId, (run) => !ACTIVE_RUN_STATUSES.includes(run.status), `run ${runId} to finish`)

const seqs = (events: RunEvent[]) => events.map((event) => event.seq)
const types = (events: RunEvent[]) => events.map((event) => event.type)

/** Event numbers are gap-free from 1. */
function assertGapFree(events: RunEvent[]): void {
  assert.deepEqual(
    seqs(events),
    events.map((_, index) => index + 1),
  )
}

async function conversation(client: TestClient, id: string, query = ""): Promise<ConversationWithRuns> {
  const res = await client.call<Ok<ConversationWithRuns>>(agentPath(`/conversations/${id}${query}`))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

async function listPage(client: TestClient, query = ""): Promise<ConversationPage> {
  const res = await client.call<Ok<ConversationPage>>(agentPath(`/conversations${query}`))
  assert.equal(res.status, 200, res.text)
  return res.body.result
}

const ended = (reader: SseReader, label: string) => reader.until((stream) => stream.ended, label)

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

  main = await serve()
  owner = (await signIn(main.app.baseUrl, "owner@example.com", "Owner")).client
  const created = await owner.call<Ok<Workspace>>("/api/v1/workspaces", {
    method: "POST",
    json: { name: "Acme", slug: "acme" },
  })
  assert.equal(created.status, 201, created.text)
  acme = created.body.result
  const memberSession = await signIn(main.app.baseUrl, "member@example.com", "Member")
  member = memberSession.client
  await new WorkspacesRepository(storage).addMember(acme.id, memberSession.context.user.id, "member")
  outsider = (await signIn(main.app.baseUrl, "outsider@example.com", "Outsider")).client

  const saved = await owner.call<Ok<Connection>>(`/api/v1/workspaces/${acme.id}/connections`, {
    method: "POST",
    json: {
      name: "Demo store (synthetic)",
      engine: "postgres",
      config: source.config,
      password: source.password,
      schemas: ["shop", "support"],
    },
  })
  assert.equal(saved.status, 201, saved.text)
  connection = saved.body.result
  const reads = manifestClient(owner, `/api/v1/workspaces/${acme.id}/connections/${connection.id}/manifest`)
  const first = await reads.latestRefresh()
  assert.ok(first)
  assert.equal((await reads.finished(first.id)).status, "succeeded")
})

after(async () => {
  if (skip) return
  consoleCapture.restore()
  for (const backend of backends) {
    await backend.runner.shutdown()
    await backend.app.close().catch(() => {})
  }
  await queries.shutdown()
  await refreshes.shutdown()
  await closeSourceAdapters(sources)
  await storage.end()
  await sourcePool.end()
})

test(
  "the conversation list pages by latest activity, shows how the latest question stands, and is private",
  { skip },
  async () => {
    const opened: AgentRun[] = []
    for (const name of ["first", "second", "third"]) {
      const run = await ask(owner, `List ${name} [plain]`)
      await finished(owner, run.id)
      opened.push(run)
    }
    const [first, second, third] = opened
    assert.ok(first && second && third)
    // A follow-up is activity: the first conversation moves to the top.
    const followUp = await ask(owner, "Again [ask]", { conversationId: first.conversationId })
    await until(owner, followUp.id, (run) => run.status === "awaiting_input", "the follow-up to ask")

    const page = await listPage(owner, "?limit=2")
    assert.deepEqual(
      page.conversations.map((item) => item.id),
      [first.conversationId, third.conversationId],
    )
    const top = page.conversations[0]
    assert.equal(top?.title, "List first [plain]")
    assert.equal(top?.status, "awaiting_input")
    assert.equal(top?.pendingClarification, true)
    assert.equal(page.conversations[1]?.status, "completed")
    assert.equal(page.conversations[1]?.pendingClarification, false)
    assert.ok(page.nextCursor)

    const rest = await listPage(owner, `?limit=2&cursor=${page.nextCursor}`)
    assert.equal(rest.conversations[0]?.id, second.conversationId, "the next page goes on without repeats")
    const all = [...page.conversations, ...rest.conversations].map((item) => item.id)
    assert.equal(new Set(all).size, all.length)

    assert.equal((await owner.call(agentPath("/conversations?cursor=nonsense"))).status, 422)
    assert.equal((await owner.call(agentPath("/conversations?limit=51"))).status, 422)
    assert.deepEqual((await listPage(member)).conversations, [], "members see only their own conversations")
    assert.equal((await outsider.call(agentPath("/conversations"))).status, 404)

    // Rename: trimmed, validated, private, and CSRF-protected; it is not activity.
    const path = agentPath(`/conversations/${third.conversationId}`)
    const renamed = await owner.call<Ok<{ title: string }>>(path, {
      method: "PATCH",
      json: { title: "  Third, renamed " },
    })
    assert.equal(renamed.status, 200, renamed.text)
    assert.equal(renamed.body.result.title, "Third, renamed")
    assert.equal((await owner.call(path, { method: "PATCH", json: { title: " " } })).status, 422)
    assert.equal((await owner.call(path, { method: "PATCH", json: { title: "x".repeat(121) } })).status, 422)
    assert.equal(
      (await owner.call(path, { method: "PATCH", json: { title: "Mine" }, csrf: false })).status,
      403,
    )
    assert.equal((await member.call(path, { method: "PATCH", json: { title: "Mine" } })).status, 404)
    assert.equal((await outsider.call(path, { method: "PATCH", json: { title: "Mine" } })).status, 404)
    assert.equal((await member.call(path, { method: "DELETE" })).status, 404)
    assert.equal((await listPage(owner, "?limit=2")).conversations[1]?.title, "Third, renamed")

    await owner.call(runPath(followUp.id, "/cancel"), { method: "POST" })
  },
)

test(
  "a conversation reads back in full from a new backend process, with older runs a page away",
  { skip },
  async () => {
    const opening = await ask(owner, "Count the orders [evidence]")
    const done = await finished(owner, opening.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    const followUp = await ask(owner, "And again [plain]", { conversationId: opening.conversationId })
    await finished(owner, followUp.id)

    const restarted = await serve()
    const read = await conversation(clientOf(restarted), opening.conversationId)
    assert.equal(read.hasEarlier, false)
    assert.deepEqual(
      read.runs.map((run) => [run.question, run.status]),
      [
        ["Count the orders [evidence]", "completed"],
        ["And again [plain]", "completed"],
      ],
    )
    const [first] = read.runs
    assert.equal(first?.answer?.markdown, "Counted.")
    assert.equal(first?.answer?.evidence[0]?.label, "Orders")
    assert.equal(types(first?.events ?? []).at(-1), "answer.completed")

    const earlier = await conversation(clientOf(restarted), opening.conversationId, `?before=${followUp.id}`)
    assert.deepEqual(
      earlier.runs.map((run) => run.id),
      [opening.id],
    )
    assert.equal(earlier.hasEarlier, false)
    assert.equal((await member.call(agentPath(`/conversations/${opening.conversationId}`))).status, 404)
    await stop(restarted)
  },
)

test(
  "replay after a sequence never repeats or reorders events, and a stream asked to start past the end still ends",
  { skip },
  async () => {
    const run = await ask(owner, "Replay me [stream]")
    // Past every event the run will have: the stream must still end with the run.
    const ahead = await openStream(owner, `${runPath(run.id, "/events")}?after=999`)
    const live = await openStream(owner, runPath(run.id, "/events"))
    await ended(live, "the live stream to end")
    await ended(ahead, "the stream that started past the end to end")
    assert.deepEqual(ahead.events(), [])

    const stored = (await finished(owner, run.id)).events
    assertGapFree(stored)
    assert.deepEqual(live.events(), stored)
    for (const from of [0, 1, 3, stored.length - 1]) {
      assert.deepEqual(seqs((await read(owner, run.id, from)).events), seqs(stored).slice(from))
      const replay = await openStream(owner, `${runPath(run.id, "/events")}?after=${from}`)
      await ended(replay, `the replay after ${from} to end`)
      assert.deepEqual(replay.events(), stored.slice(from))
    }
    // The streamed text and the final answer come once each, the answer last.
    assert.equal(stored.filter((event) => event.type === "answer.completed").length, 1)
    assert.equal(stored.at(-1)?.type, "answer.completed")
    const atEnd = await openStream(owner, `${runPath(run.id, "/events")}?after=${stored.length}`)
    await ended(atEnd, "the caught-up stream to end")
    assert.deepEqual(atEnd.events(), [])
  },
)

test(
  "a crash leaves a running run interrupted and retryable; the retry is a new run with the same question, sources, and files, made once",
  { skip },
  async () => {
    const crashed = await serve()
    const files = [{ name: "notes.md", content: Buffer.from("# Notes").toString("base64") }]
    const run = await ask(clientOf(crashed), "Take a while [slow]", {
      connectionIds: [connection.id],
      attachments: files,
    })
    await until(clientOf(crashed), run.id, (current) => current.status === "running", "the run to start")
    // The new process starts while the old one is gone (its run still works on here and must not write on).
    assert.ok((await new AgentRunsRepository(storage).recoverAfterRestart()).interrupted >= 1)
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await stop(crashed)

    const restarted = await serve()
    const client = clientOf(restarted)
    const interrupted = await read(client, run.id)
    assert.equal(interrupted.status, "interrupted")
    assert.equal(interrupted.disposition, "retry")
    assert.equal(interrupted.error?.code, "AGENT_INTERRUPTED")
    assertGapFree(interrupted.events)
    assert.deepEqual(types(interrupted.events), ["run.started", "run.interrupted"])
    const last = interrupted.events.at(-1)
    assert.ok(last?.type === "run.interrupted")
    assert.equal(last.data.disposition, "retry")

    const retryPath = runPath(run.id, "/retry")
    assert.equal((await client.call(retryPath, { method: "POST", csrf: false })).status, 403)
    assert.equal((await member.call(retryPath, { method: "POST" })).status, 404)
    const retried = await client.call<Ok<AgentRun>>(retryPath, { method: "POST" })
    assert.equal(retried.status, 202, retried.text)
    const retry = retried.body.result
    assert.notEqual(retry.id, run.id)
    assert.equal(retry.retryOf, run.id)
    assert.equal(retry.conversationId, run.conversationId)
    assert.equal(retry.question, run.question)
    assert.deepEqual(retry.connectionIds, [connection.id])
    assert.deepEqual(
      retry.attachments.map(({ name, sizeBytes }) => [name, sizeBytes]),
      run.attachments.map(({ name, sizeBytes }) => [name, sizeBytes]),
    )
    const again = await client.call<Ok<AgentRun>>(retryPath, { method: "POST" })
    assert.equal(again.status, 200, "retrying again returns the retry")
    assert.equal(again.body.result.id, retry.id)

    const done = await finished(client, retry.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    const notInterrupted = await client.call<Failure>(runPath(retry.id, "/retry"), { method: "POST" })
    assert.equal(notInterrupted.status, 409)

    // A run that started a tool with effects must be reconciled, not retried blindly.
    await storage.query(
      "UPDATE agent_runs SET status = 'interrupted', disposition = 'reconcile' WHERE id = $1",
      [retry.id],
    )
    const reconcile = await client.call<Failure>(runPath(retry.id, "/retry"), { method: "POST" })
    assert.equal(reconcile.status, 409)
    assert.equal(reconcile.body.error.details?.disposition, "reconcile")
    await stop(restarted)
  },
)

test(
  "a run waiting for an answer survives a restart and goes on from its checkpoint when answered",
  { skip },
  async () => {
    const earlier = await serve()
    const run = await ask(clientOf(earlier), "How many orders? [clarify]")
    const waiting = await until(
      clientOf(earlier),
      run.id,
      (current) => current.status === "awaiting_input",
      "the question",
    )
    // Shutdown ends the streams following the wait, so they do not keep the old process alive.
    const following = await openStream(
      clientOf(earlier),
      `${runPath(run.id, "/events")}?after=${waiting.events.at(-1)?.seq ?? 0}`,
    )
    await following.until((reader) => reader.frames.length > 0, "the stream to open")
    await stop(earlier)
    await ended(following, "the stream to end on shutdown")
    assert.deepEqual(following.events(), [])

    // The restart keeps the wait.
    await new AgentRunsRepository(storage).recoverAfterRestart()
    const later = await serve()
    const client = clientOf(later)
    const reloaded = await conversation(client, run.conversationId)
    const kept = reloaded.runs.at(-1)
    assert.equal(kept?.status, "awaiting_input")
    assert.deepEqual(kept?.clarification, waiting.clarification)
    assert.equal(types(kept?.events ?? []).at(-1), "clarification.requested")

    const stream = await openStream(
      client,
      `${runPath(run.id, "/events")}?after=${kept?.events.at(-1)?.seq ?? 0}`,
    )
    const notOffered = await client.call<Failure>(runPath(run.id, "/answer"), {
      method: "POST",
      json: { answer: "Some" },
    })
    assert.equal(notOffered.status, 422)
    const answered = await client.call<Ok<AgentRunWithEvents>>(runPath(run.id, "/answer"), {
      method: "POST",
      json: { answer: "Paid only" },
    })
    assert.equal(answered.status, 200, answered.text)
    assert.notEqual(answered.body.result.status, "awaiting_input")
    await ended(stream, "the stream to end")

    const done = await finished(client, run.id)
    assert.equal(done.status, "completed", JSON.stringify(done.error))
    // The model went on with what it did before the restart, including the query its answer cites.
    assert.equal(done.answer?.markdown, "Counted paid only after run_query.")
    const queried = waiting.events.find(
      (event): event is Extract<RunEvent, { type: "tool.finished" }> => event.type === "tool.finished",
    )
    assert.ok(queried?.data.executionId)
    assert.equal(done.answer?.evidence[0]?.executionId, queried.data.executionId)
    assertGapFree(done.events)
    assert.deepEqual(types(done.events), [
      "run.started",
      "tool.started",
      "tool.finished",
      "tool.started",
      "clarification.requested",
      "clarification.answered",
      "tool.finished",
      "tool.started",
      "tool.finished",
      "answer.completed",
    ])
    assert.deepEqual(stream.events(), done.events.slice(waiting.events.length))
    const twice = await client.call(runPath(run.id, "/answer"), {
      method: "POST",
      json: { answer: "Paid only" },
    })
    assert.equal(twice.status, 409)
    await stop(later)
  },
)

test(
  "after a restart a waiting run can be cancelled, and one whose time to answer ran out is stopped",
  { skip },
  async () => {
    const earlier = await serve({ AGENT_ANSWER_TIMEOUT_MS: "1500" })
    const cancelled = await ask(clientOf(earlier), "Cancel me later [ask]")
    await until(
      clientOf(earlier),
      cancelled.id,
      (run) => run.status === "awaiting_input",
      "the first question",
    )
    const expiring = await ask(clientOf(earlier), "Nobody answers [ask]")
    await until(
      clientOf(earlier),
      expiring.id,
      (run) => run.status === "awaiting_input",
      "the second question",
    )
    await stop(earlier)

    const later = await serve()
    const client = clientOf(later)
    const stream = await openStream(client, runPath(cancelled.id, "/events"))
    const stopped = await client.call<Ok<AgentRunWithEvents>>(runPath(cancelled.id, "/cancel"), {
      method: "POST",
    })
    assert.equal(stopped.status, 200, stopped.text)
    assert.equal(stopped.body.result.status, "cancelled")
    assert.equal(stopped.body.result.clarification, null)
    assertGapFree(stopped.body.result.events)
    await ended(stream, "the stream of the cancelled run to end")
    assert.equal(stream.events<RunEvent>().at(-1)?.type, "run.cancelled")

    await new Promise((resolve) => setTimeout(resolve, 1_600))
    const late = await client.call<Failure>(runPath(expiring.id, "/answer"), {
      method: "POST",
      json: { answer: "May" },
    })
    assert.equal(late.status, 409)
    assert.match(late.body.error.message, /No reply to the clarification arrived/)
    const timedOut = await read(client, expiring.id)
    assert.equal(timedOut.status, "failed")
    assert.equal(timedOut.error?.code, "AGENT_INPUT_TIMEOUT")
    assert.equal(timedOut.events.at(-1)?.type, "run.failed")
    await stop(later)
  },
)

test("a question sent again with the same mutationId returns the run it started", { skip }, async () => {
  const mutationId = randomUUID()
  const first = await ask(owner, "Exactly once [plain]", { mutationId })
  const again = await owner.call<Ok<AgentRun>>(agentPath("/runs"), {
    method: "POST",
    json: { question: "Exactly once [plain]", mutationId },
  })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.body.result.id, first.id)
  assert.equal(again.body.result.conversationId, first.conversationId)
  assert.equal((await conversation(owner, first.conversationId)).runs.length, 1)
  await finished(owner, first.id)

  const other = await owner.call<Failure>(agentPath("/runs"), {
    method: "POST",
    json: { question: "Something else [plain]", mutationId },
  })
  assert.equal(other.status, 409)
  // Another user's mutation ids are theirs.
  const theirs = await member.call<Ok<AgentRun>>(agentPath("/runs"), {
    method: "POST",
    json: { question: "Exactly once [plain]", mutationId },
  })
  assert.equal(theirs.status, 202, theirs.text)
  assert.notEqual(theirs.body.result.id, first.id)

  // Two copies sent at once start one run (and one conversation).
  const racing = randomUUID()
  const both = await Promise.all(
    [1, 2].map(() =>
      owner.call<Ok<AgentRun>>(agentPath("/runs"), {
        method: "POST",
        json: { question: "Sent twice [plain]", mutationId: racing },
      }),
    ),
  )
  assert.deepEqual(both.map((res) => res.status).sort(), [200, 202])
  assert.equal(both[0]?.body.result.id, both[1]?.body.result.id)
  const titled = (await listPage(owner, "?limit=50")).conversations.filter(
    (item) => item.title === "Sent twice [plain]",
  )
  assert.equal(titled.length, 1)
  await finished(owner, String(both[0]?.body.result.id))
  await finished(member, theirs.body.result.id)
})

test(
  "deleting a conversation stops its active run first and unpins the executions its answers cited",
  { skip },
  async () => {
    const cited = await ask(owner, "Count before deleting [evidence]")
    const done = await finished(owner, cited.id)
    const executionId = done.answer?.evidence[0]?.executionId
    assert.ok(executionId)
    const pinned = async () =>
      (
        await storage.query<{ pinned: boolean }>("SELECT pinned FROM query_executions WHERE id = $1", [
          executionId,
        ])
      ).rows[0]?.pinned
    assert.equal(await pinned(), true)

    const waiting = await ask(owner, "Then wait [ask]", { conversationId: cited.conversationId })
    await until(owner, waiting.id, (run) => run.status === "awaiting_input", "the question")
    const stream = await openStream(owner, runPath(waiting.id, "/events"))
    await stream.until((reader) => reader.events().length > 0, "the replayed events")

    const path = agentPath(`/conversations/${cited.conversationId}`)
    assert.equal((await owner.call(path, { method: "DELETE", csrf: false })).status, 403)
    const deleted = await owner.call<Ok<{ deleted: boolean }>>(path, { method: "DELETE" })
    assert.equal(deleted.status, 200, deleted.text)
    assert.deepEqual(deleted.body.result, { deleted: true })
    await ended(stream, "the stream of the stopped run to end")
    assert.equal(stream.events<RunEvent>().at(-1)?.type, "run.cancelled")
    assert.equal(main.runner.events.followers(waiting.id), 0)

    assert.equal((await owner.call(path)).status, 404)
    assert.equal((await owner.call(runPath(waiting.id))).status, 404)
    assert.equal((await owner.call(path, { method: "DELETE" })).status, 404)
    assert.ok(
      !(await listPage(owner, "?limit=50")).conversations.some((item) => item.id === cited.conversationId),
    )
    assert.equal(await pinned(), false)
    // The user may ask again at once: the stopped run no longer holds a place.
    await finished(owner, (await ask(owner, "Fresh start [plain]")).id)
  },
)

test("a user can follow at most ten runs at once; closing a stream frees a place", { skip }, async () => {
  const run = await ask(owner, "Watch me [ask]")
  await until(owner, run.id, (current) => current.status === "awaiting_input", "the question")
  const streams: SseReader[] = []
  for (let index = 0; index < 10; index += 1) {
    const stream = await openStream(owner, runPath(run.id, "/events"))
    assert.equal(stream.response.status, 200)
    streams.push(stream)
  }
  const refused = await owner.call<Failure>(runPath(run.id, "/events"))
  assert.equal(refused.status, 429)
  assert.equal(refused.body.error.code, "TOO_MANY_STREAMS")
  assert.equal(refused.headers.get("retry-after"), "5")
  // Other users are not affected.
  assert.equal((await member.call(runPath(run.id, "/events"))).status, 404)

  streams.shift()?.close()
  await waitFor(
    async () => main.runner.events.followers(run.id),
    (count) => count === 9,
    "the closed stream to stop following",
  )
  const reopened = await openStream(owner, runPath(run.id, "/events"))
  assert.equal(reopened.response.status, 200)
  streams.push(reopened)

  await owner.call(runPath(run.id, "/cancel"), { method: "POST" })
  for (const stream of streams) await ended(stream, "each stream to end with the run")
  const after = await openStream(owner, runPath(run.id, "/events"))
  assert.equal(after.response.status, 200, "ended streams free their places")
  await ended(after, "the stream of the finished run to end")
})

test("passwords never appear in responses or console output", { skip }, () => {
  for (const text of [...owner.responses, ...member.responses, ...consoleCapture.lines]) {
    assert.ok(!text.includes(source.password), "the source password leaked")
    assert.ok(!/sealed_?secret/i.test(text), "the sealed secret leaked")
  }
})
