export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string | undefined

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

interface ErrorEnvelope {
  success: false
  error?: { code?: string; message?: string; requestId?: string }
}

export function unwrapEnvelope<T>(status: number, body: unknown): T {
  if (typeof body === "object" && body !== null && "success" in body) {
    const envelope = body as { success: boolean; result?: T } & ErrorEnvelope
    if (envelope.success) return envelope.result as T
    throw new ApiError(
      status,
      envelope.error?.code ?? "UNKNOWN_ERROR",
      envelope.error?.message ?? "Request failed",
      envelope.error?.requestId,
    )
  }
  throw new ApiError(status, "INVALID_RESPONSE", "The server returned an unexpected response")
}

export interface ApiRequestOptions {
  method?: string
  body?: unknown
  workspaceId?: string | null
  signal?: AbortSignal
}

function apiBaseUrl(): string {
  const configured = import.meta.env?.VITE_API_BASE_URL as string | undefined
  return configured ? configured.replace(/\/$/, "") : ""
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (options.body !== undefined) headers["Content-Type"] = "application/json"
  if (options.workspaceId) headers["X-Workspace-Id"] = options.workspaceId

  let response: Response
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the Manifest API. Is the backend running?")
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok && (body === null || typeof body !== "object" || !("success" in body))) {
    throw new ApiError(response.status, "HTTP_ERROR", `Request failed (${response.status})`)
  }
  return unwrapEnvelope<T>(response.status, body)
}
