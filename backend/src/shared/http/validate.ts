import type { NextFunction, Request, Response } from "express"
import type { ZodError, ZodType } from "zod"

import { AppError } from "./errors.js"

type Source = "body" | "query" | "params"

function invalid(source: Source, error: ZodError): AppError {
  return AppError.validation(`Invalid ${source}`, {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  })
}

export function validate(source: Source, schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[source])
    if (!parsed.success) {
      next(invalid(source, parsed.error))
      return
    }
    // Replace with the parsed value so handlers see coerced/defaulted input.
    ;(req as unknown as Record<Source, unknown>)[source] = parsed.data
    next()
  }
}

/** Parses input that is only complete after merging with stored state, failing like validate(). */
export function parseInput<T>(schema: ZodType<T>, value: unknown, source: Source = "body"): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw invalid(source, parsed.error)
  return parsed.data
}
