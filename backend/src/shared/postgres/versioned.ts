/** The outcome of a save that names the version it started from (optimistic concurrency). */
export type VersionedSave<T> =
  | { status: "saved"; record: T }
  | { status: "stale"; current: T }
  | { status: "missing" }

/**
 * Classifies a conditional `UPDATE ... WHERE version = $n` by reading the row
 * back: saved when it updated, stale when the row exists at another version.
 */
export async function versionedOutcome<T>(
  updated: boolean,
  read: () => Promise<T | null>,
): Promise<VersionedSave<T>> {
  const record = await read()
  if (!record) return { status: "missing" }
  return updated ? { status: "saved", record } : { status: "stale", current: record }
}
