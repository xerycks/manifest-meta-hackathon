import assert from "node:assert/strict"
import test from "node:test"

import { QueryRunner } from "../../src/queries/runner.js"

/** A task that runs until released or aborted, recording how it ended. */
function blocking(log: string[], name: string) {
  let release = () => {}
  const task = (signal: AbortSignal) =>
    new Promise<string>((resolve) => {
      release = () => resolve(`${name}:done`)
      if (signal.aborted) resolve(`${name}:${String(signal.reason)}`)
      signal.addEventListener("abort", () => {
        log.push(`${name}:${String(signal.reason)}`)
        resolve(`${name}:${String(signal.reason)}`)
      })
    })
  return { task, release: () => release() }
}

const job = (id: string, workspaceId = "w1", connectionId = "c1") => ({
  id,
  workspaceId,
  connectionId,
  userId: "u1",
})

test("admits two queries per source, four per workspace, sixteen per process; the rest fail fast", async () => {
  const runner = new QueryRunner()
  const log: string[] = []
  const run = (id: string, workspaceId: string, connectionId: string) =>
    runner.run(job(id, workspaceId, connectionId), blocking(log, id).task)

  const first = blocking(log, "a")
  assert.ok(runner.run(job("a", "w1", "c1"), first.task))
  assert.ok(run("b", "w1", "c1"))
  assert.equal(run("c", "w1", "c1"), null, "third on one source")
  assert.ok(run("d", "w1", "c2"))
  assert.ok(run("e", "w1", "c3"))
  assert.equal(run("f", "w1", "c4"), null, "fifth in one workspace")

  for (let index = 0; index < 12; index += 1) {
    assert.ok(run(`g${index}`, `w${2 + Math.floor(index / 4)}`, `s${index}`), `slot ${index}`)
  }
  assert.equal(run("h", "w9", "c9"), null, "seventeenth in the process")

  // Finished and cancelled queries free their slots.
  first.release()
  await runner.cancel("w1", "b")
  assert.ok(run("c", "w1", "c1"))
  await runner.shutdown()
})

test("the same id cannot run twice in a workspace", async () => {
  const runner = new QueryRunner()
  const first = blocking([], "first")
  assert.ok(runner.run(job("same"), first.task))
  assert.equal(runner.run(job("same"), first.task), null)
  assert.ok(runner.find("w1", "same"))
  assert.equal(runner.find("w2", "same"), undefined)
  first.release()
  await runner.shutdown()
})

test("cancel aborts with 'cancelled' and waits for the task; shutdown aborts the rest", async () => {
  const runner = new QueryRunner()
  const log: string[] = []
  const a = blocking(log, "a")
  const b = blocking(log, "b")
  const runningA = runner.run(job("a"), a.task)
  const runningB = runner.run(job("b", "w2", "c2"), b.task)
  assert.equal(await runner.cancel("w1", "a"), true)
  assert.equal(await runningA, "a:cancelled")
  assert.equal(runner.find("w1", "a"), undefined)
  assert.equal(await runner.cancel("w1", "a"), false)

  await runner.shutdown()
  assert.equal(await runningB, "b:shutdown")
  // Tasks admitted while shutting down start already aborted.
  const late = blocking(log, "late")
  assert.equal(await runner.run(job("late"), late.task), "late:shutdown")
})
