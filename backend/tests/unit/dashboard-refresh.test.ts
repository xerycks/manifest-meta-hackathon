import assert from "node:assert/strict"
import { setImmediate as tick } from "node:timers/promises"
import test from "node:test"

import { DashboardRefresher, type RefreshOptions } from "../../src/dashboards/refresh.js"
import { AppError } from "../../src/shared/http/errors.js"

const WORKSPACE = "w"
const FAST: RefreshOptions = { concurrency: 2, firstDelayMs: 1, maxDelayMs: 4, busyTimeoutMs: 1_000 }

/** A run that stays in flight until released or aborted. */
function heldRun() {
  let release = () => {}
  const calls: AbortSignal[] = []
  const run = (signal: AbortSignal) => {
    calls.push(signal)
    return new Promise<void>((resolve) => {
      release = resolve
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }
  return { run, calls, release: () => release() }
}

async function settled(refresher: DashboardRefresher, dashboardId: string, ids: string[]): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const progress = refresher.progress(WORKSPACE, dashboardId, ids)
    if (!progress.active && progress.refreshing.size === 0) return
    await tick()
  }
  throw new Error(`refresh of ${dashboardId} did not finish`)
}

test("panels and refreshes that share a saved query share one run", async () => {
  const refresher = new DashboardRefresher(FAST)
  const held = heldRun()
  refresher.start(WORKSPACE, "d1", [
    { savedQueryId: "q", run: held.run },
    { savedQueryId: "q", run: held.run },
  ])
  // A second viewer's refresh, or another dashboard's, joins the run in flight.
  refresher.start(WORKSPACE, "d1", [{ savedQueryId: "q", run: held.run }])
  refresher.start(WORKSPACE, "d2", [{ savedQueryId: "q", run: held.run }])
  await tick()
  assert.equal(held.calls.length, 1)
  const progress = refresher.progress(WORKSPACE, "d2", ["q"])
  assert.equal(progress.active, true)
  assert.match(progress.refreshing.get("q") ?? "", /^\d{4}-\d\d-\d\dT/)
  held.release()
  await settled(refresher, "d1", ["q"])
  await settled(refresher, "d2", ["q"])
  assert.equal(held.calls.length, 1)
})

test("a refresh runs at most `concurrency` saved queries at once and queues the rest", async () => {
  const refresher = new DashboardRefresher(FAST)
  const runs = ["a", "b", "c"].map(() => heldRun())
  refresher.start(
    WORKSPACE,
    "d",
    runs.map((held, index) => ({ savedQueryId: `q${index}`, run: held.run })),
  )
  await tick()
  assert.deepEqual(
    runs.map((held) => held.calls.length),
    [1, 1, 0],
  )
  assert.equal(refresher.progress(WORKSPACE, "d", ["q2"]).refreshing.get("q2"), null)
  runs[0]?.release()
  await tick()
  await tick()
  assert.equal(runs[2]?.calls.length, 1)
  // Asking again while the refresh lasts does not rerun what it already refreshed.
  refresher.start(WORKSPACE, "d", [{ savedQueryId: "q0", run: runs[0]?.run ?? (async () => {}) }])
  await tick()
  assert.equal(runs[0]?.calls.length, 1)
  runs[1]?.release()
  runs[2]?.release()
  await settled(refresher, "d", ["q0", "q1", "q2"])
})

test("a run refused for lack of a slot waits and tries again", async () => {
  const refresher = new DashboardRefresher(FAST)
  let attempts = 0
  refresher.start(WORKSPACE, "d", [
    {
      savedQueryId: "q",
      run: async () => {
        attempts += 1
        if (attempts < 3) throw AppError.queryBusy("Too many queries are running.", 5)
      },
    },
  ])
  await settled(refresher, "d", ["q"])
  assert.equal(attempts, 3)
  assert.equal(refresher.progress(WORKSPACE, "d", ["q"]).failures.size, 0)
})

test("a run that never gets a slot, or cannot run, is reported as failed", async () => {
  const refresher = new DashboardRefresher({ ...FAST, busyTimeoutMs: 10 })
  refresher.start(WORKSPACE, "d", [
    {
      savedQueryId: "busy",
      run: async () => {
        throw AppError.queryBusy("Too many queries are running.", 5)
      },
    },
    {
      savedQueryId: "bad",
      run: async () => {
        throw AppError.invalidParameters("“since” needs a value.", { missing: ["since"] })
      },
    },
  ])
  await settled(refresher, "d", ["busy", "bad"])
  const { failures } = refresher.progress(WORKSPACE, "d", ["busy", "bad"])
  assert.equal(failures.get("busy")?.code, "QUERY_BUSY")
  assert.match(failures.get("busy")?.message ?? "", /Too many queries kept running/)
  assert.deepEqual(
    { code: failures.get("bad")?.code, message: failures.get("bad")?.message },
    { code: "INVALID_PARAMETERS", message: "“since” needs a value." },
  )
  // The next run of a saved query clears its failure.
  refresher.start(WORKSPACE, "d", [{ savedQueryId: "bad", run: async () => {} }])
  await settled(refresher, "d", ["bad"])
  assert.equal(refresher.progress(WORKSPACE, "d", ["bad"]).failures.has("bad"), false)
})

test("cancelling aborts the runs no other refresh waits on and drops queued ones", async () => {
  const refresher = new DashboardRefresher({ ...FAST, concurrency: 2 })
  const own = heldRun()
  const shared = heldRun()
  const queued = heldRun()
  refresher.start(WORKSPACE, "d1", [
    { savedQueryId: "own", run: own.run },
    { savedQueryId: "shared", run: shared.run },
    { savedQueryId: "queued", run: queued.run },
  ])
  refresher.start(WORKSPACE, "d2", [{ savedQueryId: "shared", run: shared.run }])
  await tick()

  assert.equal(await refresher.cancel(WORKSPACE, "d1"), true)
  assert.equal(own.calls[0]?.aborted, true)
  assert.equal(shared.calls[0]?.aborted, false)
  assert.equal(refresher.progress(WORKSPACE, "d1", ["own"]).active, false)
  assert.equal(refresher.progress(WORKSPACE, "d2", ["shared"]).active, true)
  shared.release()
  await settled(refresher, "d2", ["shared"])
  await tick()
  assert.equal(queued.calls.length, 0)
  assert.equal(await refresher.cancel(WORKSPACE, "d1"), false)
})

test("a refresh started while a cancelled run is stopping runs the saved query again once it has stopped", async () => {
  const refresher = new DashboardRefresher(FAST)
  const calls: AbortSignal[] = []
  // An aborted run takes a moment to stop (it records how it ended on the source).
  const stops: (() => void)[] = []
  const releases: (() => void)[] = []
  const run = (signal: AbortSignal) => {
    calls.push(signal)
    return new Promise<void>((resolve) => {
      releases.push(resolve)
      signal.addEventListener("abort", () => stops.push(resolve), { once: true })
    })
  }
  refresher.start(WORKSPACE, "d1", [{ savedQueryId: "q", run }])
  await tick()
  const cancelling = refresher.cancel(WORKSPACE, "d1")
  assert.equal(calls[0]?.aborted, true)

  // Another viewer refreshes this dashboard, and another dashboard shows the same saved query.
  refresher.start(WORKSPACE, "d1", [{ savedQueryId: "q", run }])
  refresher.start(WORKSPACE, "d2", [{ savedQueryId: "q", run }])
  await tick()
  assert.equal(calls.length, 1, "no second run beside the one still stopping")
  stops[0]?.()
  await cancelling
  for (let attempt = 0; attempt < 10 && calls.length < 2; attempt += 1) await tick()

  assert.equal(calls.length, 2, "both refreshes share one new run")
  assert.equal(calls[1]?.aborted, false)
  const progress = refresher.progress(WORKSPACE, "d1", ["q"])
  assert.equal(progress.active, true)
  assert.match(progress.refreshing.get("q") ?? "", /^\d{4}-/)
  assert.equal(progress.failures.has("q"), false)
  releases[1]?.()
  await settled(refresher, "d1", ["q"])
  await settled(refresher, "d2", ["q"])
  assert.equal(calls.length, 2)
})

test("a refresh cancelled while it waits for a cancelled run to stop starts nothing", async () => {
  const refresher = new DashboardRefresher(FAST)
  const calls: AbortSignal[] = []
  const stops: (() => void)[] = []
  const run = (signal: AbortSignal) => {
    calls.push(signal)
    return new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => stops.push(resolve), { once: true })
    })
  }
  refresher.start(WORKSPACE, "d1", [{ savedQueryId: "q", run }])
  await tick()
  const first = refresher.cancel(WORKSPACE, "d1")
  refresher.start(WORKSPACE, "d2", [{ savedQueryId: "q", run }])
  await tick()
  assert.equal(await refresher.cancel(WORKSPACE, "d2"), true)
  stops[0]?.()
  await first
  await settled(refresher, "d2", ["q"])
  assert.equal(calls.length, 1)
})

test("a run cancelled while it waits for a slot is noted as cancelled", async () => {
  const refresher = new DashboardRefresher({
    ...FAST,
    firstDelayMs: 60_000,
    maxDelayMs: 60_000,
    busyTimeoutMs: 120_000,
  })
  refresher.start(WORKSPACE, "d", [
    {
      savedQueryId: "q",
      run: async () => {
        throw AppError.queryBusy("Too many queries are running.", 5)
      },
    },
  ])
  await tick()
  await refresher.cancel(WORKSPACE, "d")
  assert.equal(refresher.progress(WORKSPACE, "d", ["q"]).failures.get("q")?.code, "QUERY_CANCELLED")
})

test("shutdown stops every refresh and refuses new ones", async () => {
  const refresher = new DashboardRefresher(FAST)
  const held = heldRun()
  refresher.start(WORKSPACE, "d", [{ savedQueryId: "q", run: held.run }])
  await tick()
  await refresher.shutdown()
  assert.equal(held.calls[0]?.aborted, true)
  refresher.start(WORKSPACE, "d", [{ savedQueryId: "q", run: held.run }])
  assert.equal(refresher.progress(WORKSPACE, "d", ["q"]).active, false)
  assert.equal(held.calls.length, 1)
})
