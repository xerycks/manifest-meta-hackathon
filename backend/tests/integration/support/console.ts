import { format } from "node:util"

const METHODS = ["log", "info", "warn", "error", "debug"] as const

/** Records everything written through console.* (still printing it) until restored. */
export function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = []
  const originals = METHODS.map((method) => [method, console[method]] as const)
  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]) => {
      lines.push(format(...args))
      original(...args)
    }
  }
  return {
    lines,
    restore() {
      for (const [method, original] of originals) console[method] = original
    },
  }
}
