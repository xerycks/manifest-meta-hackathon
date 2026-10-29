import type { Response } from "express"

export interface SuccessEnvelope<T> {
  success: true
  result: T
}

export function ok<T>(res: Response, result: T, status = 200): void {
  const body: SuccessEnvelope<T> = { success: true, result }
  res.status(status).json(body)
}
