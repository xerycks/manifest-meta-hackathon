import type { NextFunction, Request, Response } from "express"
import type { ZodType } from "zod"

import { AppError } from "./errors.js"

type Source = "body" | "query" | "params"

export function validate(source: Source, schema: ZodType) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[source])
    if (!parsed.success) {
      next(
        AppError.validation(`Invalid ${source}`, {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        }),
      )
      return
    }
    // Replace with the parsed value so handlers see coerced/defaulted input.
    ;(req as unknown as Record<Source, unknown>)[source] = parsed.data
    next()
  }
}
