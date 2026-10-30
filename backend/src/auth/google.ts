import { createHash } from "node:crypto"

import { OAuth2Client } from "google-auth-library"

import type { Identity } from "./service.js"

export interface GoogleProvider {
  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string
  createPkce(): Promise<{ verifier: string; challenge: string }>
  exchange(input: { code: string; verifier: string; nonce: string }): Promise<Identity>
}

export class GoogleIdentityRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GoogleIdentityRejected"
  }
}

/**
 * Identity-only Google sign-in (openid, email, profile). Access to Google
 * files and services is a separate, later authorization — never bundled here.
 */
export function createGoogleProvider(config: {
  clientId: string
  clientSecret: string
  redirectUri: string
}): GoogleProvider {
  const client = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri)

  return {
    authorizationUrl({ state, nonce, codeChallenge }) {
      return client.generateAuthUrl({
        access_type: "online",
        scope: ["openid", "email", "profile"],
        state,
        nonce,
        code_challenge: codeChallenge,
        // google-auth-library passes this through to the auth URL.
        ...({ code_challenge_method: "S256" } as Record<string, string>),
        prompt: "select_account",
      })
    },

    async createPkce() {
      const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
      const challenge =
        codeChallenge ??
        createHash("sha256").update(codeVerifier).digest().toString("base64url")
      return { verifier: codeVerifier, challenge }
    },

    async exchange({ code, verifier, nonce }) {
      const { tokens } = await client.getToken({ code, codeVerifier: verifier })
      if (!tokens.id_token) throw new GoogleIdentityRejected("Google returned no identity token")
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.clientId,
      })
      const payload = ticket.getPayload()
      if (!payload) throw new GoogleIdentityRejected("Google identity token was empty")
      if (payload.nonce !== nonce) throw new GoogleIdentityRejected("Identity token nonce mismatch")
      if (!payload.email || payload.email_verified !== true) {
        throw new GoogleIdentityRejected("A verified Google email is required")
      }
      return {
        email: payload.email,
        name: payload.name ?? "",
        googleSubject: payload.sub,
      }
    },
  }
}
