/**
 * PostgreSQL rejected a write because it would duplicate a unique key (SQLSTATE
 * 23505), optionally of the named constraint or unique index.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  const violation = error as { code: unknown; constraint?: unknown }
  return violation.code === "23505" && (constraint === undefined || violation.constraint === constraint)
}
