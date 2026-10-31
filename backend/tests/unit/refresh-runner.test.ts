import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"

import { RefreshRunner } from "../../src/manifests/runner.js"

/** A task that records its start and resolves only when released (or aborted). */
function controllable(log: string[], name: string) {
  let release = () => {}
  const task = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        log.push(`${name}:start:${String(signal.reason)}`)
        resolve()
        return
      }
      log.push(`${name}:start`)
      release = () => {
        log.push(`${name}:end`)
        resolve()
      }
      signal.addEventListener("abort", () => {
        log.push(`${name}:aborted:${String(signal.reason)}`)
        resolve()
      })
    })
  return { task, release: () => release() }
}

test("runs at most `concurrency` refreshes at once; the next starts when a slot frees", async () => {
  const runner = new RefreshRunner(2)
  const log: string[] = []
  const a = controllable(log, "a")
  const b = controllable(log, "b")
  const c = controllable(log, "c")
  runner.start("a", a.task)
  runner.start("b", b.task)
  runner.start("c", c.task)
  await tick()
  assert.deepEqual(log, ["a:start", "b:start"])

  a.release()
  await tick()
  await tick()
  assert.deepEqual(log, ["a:start", "b:start", "a:end", "c:start"])

  b.release()
  c.release()
  await runner.shutdown()
})

test("a run cancelled while it waits starts with an aborted signal and takes no slot", async () => {
  const runner = new RefreshRunner(1)
  const log: string[] = []
  const a = controllable(log, "a")
  const b = controllable(log, "b")
  const c = controllable(log, "c")
  runner.start("a", a.task)
  runner.start("b", b.task)
  runner.start("c", c.task)
  assert.equal(runner.abort("b", "cancelled"), true)
  await tick()
  await tick()
  assert.deepEqual(log, ["a:start", "b:start:cancelled"])

  a.release()
  await tick()
  await tick()
  assert.ok(log.includes("c:start"), "the freed slot goes to the next waiting run")
  assert.equal(runner.abort("unknown", "cancelled"), false)
  c.release()
  await runner.shutdown()
})

test("shutdown aborts every run, waits for them, and stops new ones", async () => {
  const runner = new RefreshRunner(1)
  const log: string[] = []
  runner.start("a", controllable(log, "a").task)
  runner.start("b", controllable(log, "b").task)
  await tick()
  await runner.shutdown()
  assert.deepEqual(log.sort(), ["a:aborted:shutdown", "a:start", "b:start:shutdown"].sort())

  const late: string[] = []
  runner.start("c", controllable(late, "c").task)
  await runner.shutdown()
  assert.deepEqual(late, ["c:start:shutdown"])
})

test("a task that throws is contained and frees its slot", async (t) => {
  const runner = new RefreshRunner(1)
  const errors = t.mock.method(console, "error", () => {})
  const log: string[] = []
  runner.start("broken", async () => {
    throw new Error("boom")
  })
  const next = controllable(log, "next")
  runner.start("next", next.task)
  await tick()
  await tick()
  await tick()
  assert.deepEqual(log, ["next:start"])
  assert.equal(errors.mock.callCount(), 1)
  next.release()
  await runner.shutdown()
})
