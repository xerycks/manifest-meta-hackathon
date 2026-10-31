import assert from "node:assert/strict"
import { setImmediate as tick } from "node:timers/promises"
import test from "node:test"

import { loadEnv } from "../../src/config/env.js"
import { RoutineDispatcher, retryWhileBusy, SHUTDOWN } from "../../src/routines/dispatcher.js"
import { AppError } from "../../src/shared/http/errors.js"

const FAST = { firstDelayMs: 1, maxDelayMs: 4, busyTimeoutMs: 1_000 }

/** Due work as a list: each claim takes up to `limit` runs and holds them until released. */
function fakeService(dispatcher: RoutineDispatcher, due: string[]) {
  const limits: number[] = []
  const releases = new Map<string, () => void>()
  const signals: AbortSignal[] = []
  return {
    limits,
    signals,
    release: (id: string) => releases.get(id)?.(),
    async dispatch(limit: number) {
      limits.push(limit)
      for (const id of due.splice(0, limit)) {
        dispatcher.launch(id, (signal) => {
          signals.push(signal)
          return new Promise<void>((resolve) => {
            releases.set(id, resolve)
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })
      }
    },
  }
}

test("a tick claims only what fits the free capacity, and manual runs count", async () => {
  const dispatcher = new RoutineDispatcher({ concurrency: 2 })
  const service = fakeService(dispatcher, ["a", "b", "c"])
  dispatcher.attach(service)
  assert.equal(dispatcher.full, false)
  await dispatcher.tick()
  assert.deepEqual(service.limits, [2])
  assert.equal(dispatcher.running, 2)
  // Full: nothing is claimed until a run ends (and manual runs are refused).
  assert.equal(dispatcher.full, true)
  await dispatcher.tick()
  assert.deepEqual(service.limits, [2])
  service.release("a")
  await tick()
  assert.equal(dispatcher.full, false)
  await dispatcher.tick()
  assert.deepEqual(service.limits, [2, 1])
  service.release("b")
  service.release("c")
  await dispatcher.drained()
  // A manual run takes a place like a claimed one.
  dispatcher.launch("manual", () => new Promise((resolve) => setTimeout(resolve, 20)))
  await dispatcher.tick()
  assert.deepEqual(service.limits, [2, 1, 1])
  await dispatcher.drained()
  assert.equal(dispatcher.running, 0)
})

test("ticks at the same time share one claim", async () => {
  const dispatcher = new RoutineDispatcher()
  let claims = 0
  let finish = () => {}
  dispatcher.attach({
    dispatch: () => {
      claims += 1
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    },
  })
  const first = dispatcher.tick()
  const second = dispatcher.tick()
  assert.equal(first, second)
  finish()
  await Promise.all([first, second])
  assert.equal(claims, 1)
  const third = dispatcher.tick()
  finish()
  await third
  assert.equal(claims, 2)
})

test("a failed claim is logged and the next tick tries again", async () => {
  const dispatcher = new RoutineDispatcher()
  let claims = 0
  const logged: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => logged.push(args[0])
  try {
    dispatcher.attach({
      dispatch: async () => {
        claims += 1
        if (claims === 1) throw new Error("storage unavailable")
      },
    })
    await dispatcher.tick()
    await dispatcher.tick()
  } finally {
    console.error = original
  }
  assert.equal(claims, 2)
  assert.deepEqual(logged, ["Could not claim due routines"])
})

test("stop claims nothing more and aborts the runs' signal with the shutdown reason", async () => {
  const dispatcher = new RoutineDispatcher({ concurrency: 1 })
  const service = fakeService(dispatcher, ["a", "b"])
  dispatcher.attach(service)
  await dispatcher.tick()
  await dispatcher.stop()
  assert.equal(dispatcher.full, true)
  assert.equal(service.signals[0]?.aborted, true)
  assert.equal(service.signals[0]?.reason, SHUTDOWN)
  await dispatcher.drained()
  await dispatcher.tick()
  assert.deepEqual(service.limits, [1])
  // Starting after a stop does nothing either.
  dispatcher.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(service.limits, [1])
})

test("start claims right away and then every interval", async () => {
  const dispatcher = new RoutineDispatcher({ intervalMs: 5 })
  let claims = 0
  dispatcher.attach({
    dispatch: async () => {
      claims += 1
    },
  })
  dispatcher.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await dispatcher.stop()
  const counted = claims
  assert.ok(counted >= 3, `claimed ${counted} times`)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(claims, counted)
})

test("busy refusals are retried with backoff; other errors and an abort are not", async () => {
  let attempts = 0
  const busy = AppError.queryBusy("Too many queries", 5)
  const value = await retryWhileBusy(
    async () => {
      attempts += 1
      if (attempts < 3) throw busy
      return "ran"
    },
    new AbortController().signal,
    FAST,
  )
  assert.equal(value, "ran")
  assert.equal(attempts, 3)

  attempts = 0
  const failure = AppError.validation("Nope")
  await assert.rejects(
    retryWhileBusy(
      async () => {
        attempts += 1
        throw failure
      },
      new AbortController().signal,
      FAST,
    ),
    (error) => error === failure,
  )
  assert.equal(attempts, 1)

  const stopping = new AbortController()
  attempts = 0
  const gaveUp = retryWhileBusy(
    async () => {
      attempts += 1
      stopping.abort(SHUTDOWN)
      throw busy
    },
    stopping.signal,
    FAST,
  )
  await assert.rejects(gaveUp, (error) => error === busy)
  assert.equal(attempts, 1)

  // A slot that never frees up is given up on after busyTimeoutMs.
  await assert.rejects(
    retryWhileBusy(
      async () => {
        throw AppError.agentBusy("Busy", 10)
      },
      new AbortController().signal,
      { firstDelayMs: 5, maxDelayMs: 5, busyTimeoutMs: 20 },
    ),
    (error) => error instanceof AppError && error.code === "AGENT_BUSY",
  )
})

test("routine settings default to a 5-minute interval and a 15-second poll, within bounds", () => {
  const env = loadEnv({ NODE_ENV: "test" })
  assert.equal(env.ROUTINE_MIN_INTERVAL_MINUTES, 5)
  assert.equal(env.ROUTINE_POLL_INTERVAL_MS, 15_000)
  assert.equal(loadEnv({ ROUTINE_MIN_INTERVAL_MINUTES: "1" }).ROUTINE_MIN_INTERVAL_MINUTES, 1)
  assert.throws(() => loadEnv({ ROUTINE_MIN_INTERVAL_MINUTES: "0" }), /ROUTINE_MIN_INTERVAL_MINUTES/)
  assert.throws(() => loadEnv({ ROUTINE_POLL_INTERVAL_MS: "10" }), /ROUTINE_POLL_INTERVAL_MS/)
})
