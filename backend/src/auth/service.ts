import { AppError } from "../shared/http/errors.js"
import { SessionsRepository, UsersRepository, type User } from "./repository.js"
import { newToken, tokenDigest } from "./tokens.js"

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface Identity {
  email: string
  name: string
  googleSubject?: string
}

export interface EstablishedSession {
  user: User
  token: string
  expiresAt: Date
}

export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
  ) {}

  /** One sign-in path for every identity source (Google today, dev locally). */
  async signInWithIdentity(identity: Identity): Promise<EstablishedSession> {
    const user = await this.users.upsertByIdentity(identity)
    const token = newToken()
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    await this.sessions.create(user.id, tokenDigest(token), expiresAt)
    return { user, token, expiresAt }
  }

  async authenticate(token: string): Promise<{ user: User; sessionId: string }> {
    if (!token) throw AppError.unauthorized()
    const session = await this.sessions.findByTokenHash(tokenDigest(token))
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      if (session) await this.sessions.deleteByTokenHash(tokenDigest(token))
      throw AppError.unauthorized("Your session has expired. Sign in again.")
    }
    const user = await this.users.getById(session.userId)
    if (!user) throw AppError.unauthorized()
    void this.sessions.touch(session.id).catch(() => {})
    return { user, sessionId: session.id }
  }

  async logout(token: string): Promise<void> {
    if (token) await this.sessions.deleteByTokenHash(tokenDigest(token))
  }
}
