import assert from "node:assert/strict"

import type { WorkspaceMembership } from "../../../src/workspaces/repository.js"

export interface TestResponse<T> {
  status: number
  body: T
  text: string
  headers: Headers
}

export interface RequestOptions {
  method?: string
  json?: unknown
  /** Set to false to send a mutation without the CSRF header. */
  csrf?: boolean
  headers?: Record<string, string>
}

export interface SessionContext {
  user: { id: string; email: string; name: string }
  csrfToken: string
  memberships: WorkspaceMembership[]
}

/**
 * A browser-like client: keeps cookies, sends the CSRF header on requests,
 * and records every response body so tests can check for leaked secrets.
 */
export class TestClient {
  constructor(
    readonly baseUrl: string,
    readonly cookies = new Map<string, string>(),
    readonly responses: string[] = [],
    public csrf = "",
  ) {}

  /** The same browser session against another running server (e.g. after a restart). */
  at(baseUrl: string): TestClient {
    return new TestClient(baseUrl, this.cookies, this.responses, this.csrf)
  }

  async call<T = unknown>(path: string, options: RequestOptions = {}): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers }
    if (options.json !== undefined) headers["Content-Type"] = "application/json"
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    if (cookie) headers.Cookie = cookie
    if (options.csrf !== false && this.csrf) headers["X-Manifest-CSRF"] = this.csrf

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      redirect: "manual",
      ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    })
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(";")
      const eq = pair?.indexOf("=") ?? -1
      if (pair && eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    const text = await response.text()
    this.responses.push(text)
    let body: T
    try {
      body = JSON.parse(text) as T
    } catch {
      body = text as T
    }
    return { status: response.status, body, text, headers: response.headers }
  }
}

/** Signs in through the local development route (the app must enable ALLOW_DEV_LOGIN). */
export async function signIn(
  baseUrl: string,
  email: string,
  name = "",
): Promise<{ client: TestClient; context: SessionContext }> {
  const client = new TestClient(baseUrl)
  const res = await client.call<{ result: SessionContext }>("/api/v1/auth/dev", {
    method: "POST",
    json: { email, name },
  })
  assert.equal(res.status, 200, res.text)
  assert.ok(client.cookies.has("manifest_session"))
  client.csrf = res.body.result.csrfToken
  return { client, context: res.body.result }
}
