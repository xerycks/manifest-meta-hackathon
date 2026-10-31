import { QUERY_LIMITS, type Cell, type TruncatedBy } from "./schemas.js"

const rowBytes = (row: Cell[]) => Buffer.byteLength(JSON.stringify(row)) + 1

/**
 * Collects encoded rows up to the row and byte limits. Executors read one row
 * past maxRows, so a full builder tells whether the result was cut and why.
 */
export class ResultCollector {
  readonly rows: Cell[][] = []
  truncatedBy: TruncatedBy | null = null
  private bytes = 0

  constructor(
    private readonly maxRows: number,
    private readonly maxBytes: number = QUERY_LIMITS.resultBytes,
  ) {}

  get full(): boolean {
    return this.truncatedBy !== null
  }

  /**
   * Keeps the row, or returns false (keeping nothing) once a limit is reached.
   * `extraBytes` counts what keeping it adds elsewhere, such as padding earlier rows.
   */
  add(row: Cell[], extraBytes = 0): boolean {
    if (this.full) return false
    if (this.rows.length >= this.maxRows) {
      this.truncatedBy = "rows"
      return false
    }
    const size = rowBytes(row) + extraBytes
    if (this.bytes + size > this.maxBytes) {
      this.truncatedBy = "bytes"
      return false
    }
    this.rows.push(row)
    this.bytes += size
    return true
  }
}

/** The leading rows a record keeps: at most `maxRows`, and no more than `maxBytes` serialized. */
export function snapshotRows(
  rows: Cell[][],
  maxRows: number = QUERY_LIMITS.snapshotRows,
  maxBytes: number = QUERY_LIMITS.snapshotBytes,
): Cell[][] {
  let bytes = 0
  let count = 0
  for (const row of rows.slice(0, maxRows)) {
    bytes += rowBytes(row)
    if (bytes > maxBytes) break
    count += 1
  }
  return rows.slice(0, count)
}
