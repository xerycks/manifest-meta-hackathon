export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "CSRF_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE_NOT_CONFIGURED"
  | "CONNECTIONS_NOT_CONFIGURED"
  | "SOURCE_CONNECTION_FAILED"
  | "QUERY_REJECTED"
  | "QUERY_BUSY"
  | "AGENT_NOT_CONFIGURED"
  | "AGENT_BUSY"
  | "GOOGLE_SIGN_IN_UNAVAILABLE"
  | "INTERNAL_ERROR"

export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details: unknown
  /** Extra response headers, e.g. Retry-After. */
  readonly headers: Record<string, string>

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
    headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
    this.details = details
    this.headers = headers
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, "BAD_REQUEST", message, details)
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(422, "VALIDATION_FAILED", message, details)
  }

  static notFound(message = "Resource not found"): AppError {
    return new AppError(404, "NOT_FOUND", message)
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, "CONFLICT", message, details)
  }

  /** A save based on an outdated version; `current` lets the editor show the newer one. */
  static stale(thing: string, current: unknown): AppError {
    return new AppError(
      409,
      "CONFLICT",
      `Someone else saved changes to this ${thing} after you opened it. Review their version, then save again.`,
      { current },
    )
  }

  static unauthorized(message = "Sign in to continue"): AppError {
    return new AppError(401, "UNAUTHORIZED", message)
  }

  static csrf(message = "Refresh the page and try again"): AppError {
    return new AppError(403, "CSRF_REQUIRED", message)
  }

  static forbidden(message = "You do not have permission to do this"): AppError {
    return new AppError(403, "FORBIDDEN", message)
  }

  static googleUnavailable(): AppError {
    return new AppError(503, "GOOGLE_SIGN_IN_UNAVAILABLE", "Google sign-in is not configured.")
  }

  static storageNotConfigured(): AppError {
    return new AppError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Application storage is not configured. Set DATABASE_URL and restart the backend.",
    )
  }

  static connectionsNotConfigured(): AppError {
    return new AppError(
      503,
      "CONNECTIONS_NOT_CONFIGURED",
      "Source connections are not configured. Set CONNECTION_ENCRYPTION_KEY (openssl rand -hex 32) and restart the backend.",
    )
  }

  /** Validation refused a query; details name the reason, the offending name, and the recorded execution. */
  static queryRejected(
    message: string,
    details: { executionId: string; reason: string | null; name: string | null },
  ): AppError {
    return new AppError(422, "QUERY_REJECTED", message, details)
  }

  /** Too many queries are running; the request was not started and may be retried. */
  static queryBusy(message: string, retryAfterSeconds: number): AppError {
    return new AppError(429, "QUERY_BUSY", message, { retryAfterSeconds }, {
      "Retry-After": String(retryAfterSeconds),
    })
  }

  static agentNotConfigured(): AppError {
    return new AppError(
      503,
      "AGENT_NOT_CONFIGURED",
      "No model provider is configured for answering questions. Set ANTHROPIC_API_KEY (or AGENT_PROVIDER=scripted for the local demo model) and restart the backend.",
    )
  }

  /** Too many questions are being answered; the run was not started and may be retried. */
  static agentBusy(message: string, retryAfterSeconds: number): AppError {
    return new AppError(429, "AGENT_BUSY", message, { retryAfterSeconds }, {
      "Retry-After": String(retryAfterSeconds),
    })
  }

  /** A source database could not be reached or used; `reason` is a stable machine code. */
  static sourceConnectionFailed(reason: string, message: string): AppError {
    return new AppError(422, "SOURCE_CONNECTION_FAILED", message, { reason })
  }
}
