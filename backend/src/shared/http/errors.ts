export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE_NOT_CONFIGURED"
  | "INTERNAL_ERROR"

export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details: unknown

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = "AppError"
    this.status = status
    this.code = code
    this.details = details
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

  static storageNotConfigured(): AppError {
    return new AppError(
      503,
      "STORAGE_NOT_CONFIGURED",
      "Application storage is not configured. Set DATABASE_URL and restart the backend.",
    )
  }
}
