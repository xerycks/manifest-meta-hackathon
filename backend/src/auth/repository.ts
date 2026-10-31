import type { Pool } from "pg"

export interface User {
  id: string
  email: string
  name: string
}

interface UserRow {
  id: string
  email: string
  name: string
}

/** How a member is shown next to something they wrote. */
export interface Author {
  id: string
  name: string
}

/** SQL for an author's display name (their email when they have no name) from a users alias. */
export const authorNameSql = (alias: string) => `coalesce(nullif(${alias}.name, ''), ${alias}.email)`

export function toAuthor(id: string | null, name: string | null): Author | null {
  return id !== null && name !== null ? { id, name } : null
}

export class UsersRepository {
  constructor(private readonly pool: Pool) {}

  async upsertByIdentity(input: {
    email: string
    name: string
    googleSubject?: string
  }): Promise<User> {
    const email = input.email.trim().toLowerCase()
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, name, google_subject) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE
         SET name = CASE WHEN EXCLUDED.name <> '' THEN EXCLUDED.name ELSE users.name END,
             google_subject = COALESCE(EXCLUDED.google_subject, users.google_subject),
             updated_at = now()
       RETURNING id, email, name`,
      [email, input.name, input.googleSubject ?? null],
    )
    const row = rows[0]
    if (!row) throw new Error("User upsert returned no row")
    return row
  }

  async getById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      "SELECT id, email, name FROM users WHERE id = $1",
      [id],
    )
    return rows[0] ?? null
  }
}

export interface StoredSession {
  id: string
  userId: string
  expiresAt: Date
}

export class SessionsRepository {
  constructor(private readonly pool: Pool) {}

  async create(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.pool.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [userId, tokenHash, expiresAt],
    )
  }

  async findByTokenHash(tokenHash: string): Promise<StoredSession | null> {
    const { rows } = await this.pool.query<{
      id: string
      user_id: string
      expires_at: Date
    }>("SELECT id, user_id, expires_at FROM sessions WHERE token_hash = $1", [tokenHash])
    const row = rows[0]
    return row ? { id: row.id, userId: row.user_id, expiresAt: row.expires_at } : null
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash])
  }

  async touch(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 hour'",
      [id],
    )
  }
}

export interface GoogleLoginAttempt {
  nonce: string
  sealedVerifier: string
  returnTo: string
}

export class GoogleLoginAttemptsRepository {
  constructor(private readonly pool: Pool) {}

  async begin(input: {
    stateHash: string
    browserHash: string
    nonce: string
    sealedVerifier: string
    returnTo: string
    expiresAt: Date
  }): Promise<void> {
    await this.pool.query("DELETE FROM google_login_attempts WHERE expires_at <= now()")
    await this.pool.query(
      `INSERT INTO google_login_attempts
         (state_hash, browser_hash, nonce, sealed_verifier, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.stateHash,
        input.browserHash,
        input.nonce,
        input.sealedVerifier,
        input.returnTo,
        input.expiresAt,
      ],
    )
  }

  /** Deletes and returns the attempt only when state, browser binding, and expiry all match. */
  async consume(stateHash: string, browserHash: string): Promise<GoogleLoginAttempt | null> {
    const { rows } = await this.pool.query<{
      nonce: string
      sealed_verifier: string
      return_to: string
      browser_hash: string
    }>(
      `DELETE FROM google_login_attempts
        WHERE state_hash = $1 AND expires_at > now()
        RETURNING nonce, sealed_verifier, return_to, browser_hash`,
      [stateHash],
    )
    const row = rows[0]
    if (!row || row.browser_hash !== browserHash) return null
    return { nonce: row.nonce, sealedVerifier: row.sealed_verifier, returnTo: row.return_to }
  }
}
