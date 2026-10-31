import { ApiError } from "./client.ts"

/** Client errors (404, 422, 403) are answers, not glitches: never retry them. */
export function retryServerErrors(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false
  return failureCount < 1
}
