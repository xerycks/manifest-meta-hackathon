import type { ManifestRefresh, RefreshStatus } from "./types.ts"

export function isActiveStatus(status: RefreshStatus | undefined): boolean {
  return status === "queued" || status === "running"
}

/** True while a refresh is queued or running, so progress should be polled. */
export function isRefreshActive(refresh: ManifestRefresh | null | undefined): boolean {
  return isActiveStatus(refresh?.status)
}

/**
 * The latest refresh's id once it has ended: null while one is active or none
 * has run, undefined while the latest refresh is not known yet.
 */
export function endedRefreshId(refresh: ManifestRefresh | null | undefined): string | null | undefined {
  if (refresh === undefined) return undefined
  return refresh && !isActiveStatus(refresh.status) ? refresh.id : null
}

/**
 * True when a refresh has ended since the last check (one seen running, or a
 * newer one that ended elsewhere), so published metadata may have changed.
 */
export function refreshEndedSince(
  before: string | null | undefined,
  now: string | null | undefined,
): boolean {
  return before !== undefined && typeof now === "string" && now !== before
}
