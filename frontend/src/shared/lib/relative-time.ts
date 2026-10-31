const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
]

/** "just now", "5 minutes ago", "yesterday"; dates older than a week are shown as dates. */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return ""
  const seconds = Math.round((time - now) / 1000)
  if (Math.abs(seconds) < 45) return "just now"
  if (Math.abs(seconds) >= 7 * 86_400) {
    return new Date(time).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })
  }
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(Math.round(seconds / 60), "minute")
}
