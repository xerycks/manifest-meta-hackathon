import assert from "node:assert/strict"
import test from "node:test"

import { formatRelativeTime } from "../src/shared/lib/relative-time.ts"

const NOW = Date.parse("2026-10-31T12:00:00.000Z")
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

test("formatRelativeTime reads naturally for recent times", () => {
  assert.equal(formatRelativeTime(ago(10), NOW), "just now")
  assert.equal(formatRelativeTime(ago(5 * 60), NOW), "5 minutes ago")
  assert.equal(formatRelativeTime(ago(3 * 3600), NOW), "3 hours ago")
  assert.equal(formatRelativeTime(ago(26 * 3600), NOW), "yesterday")
})

test("formatRelativeTime falls back to a date for old or invalid values", () => {
  assert.equal(formatRelativeTime(ago(30 * 86_400), NOW), "Oct 1, 2026")
  assert.equal(formatRelativeTime("not a date", NOW), "")
})
