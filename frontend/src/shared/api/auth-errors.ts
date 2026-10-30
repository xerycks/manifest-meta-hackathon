const AUTH_ERROR_MESSAGES = new Map<string, string>([
  [
    "google_cancelled",
    "Google sign-in was cancelled. You can try again when you are ready.",
  ],
  [
    "google_account_rejected",
    "Please sign in with a verified Google account. If this sign-in expired, try again.",
  ],
  ["google_unavailable", "Google sign-in is temporarily unavailable. Please try again."],
])

export function authErrorMessage(code: string | null | undefined): string {
  if (!code) return ""
  return AUTH_ERROR_MESSAGES.get(code) ?? "Sign-in failed. Please try again."
}
