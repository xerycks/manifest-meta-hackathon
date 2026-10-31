// Each question is sent with a mutationId. Sending the same question again
// after a failure reuses it, so a question that did reach the server (whose
// answer was lost on the way back) is not started twice.

export interface QuestionDraft {
  question: string
  connectionIds: string[]
  files: { name: string; size: number; lastModified: number }[]
}

/** A question being sent, or whose sending failed. */
export interface Submission {
  key: string
  mutationId: string
}

/** What makes two sends the same question: where it is asked, its text, sources, and files. */
export function submissionKey(conversationId: string | null, draft: QuestionDraft): string {
  return JSON.stringify([
    conversationId,
    draft.question.trim(),
    [...draft.connectionIds].sort(),
    draft.files.map((file) => [file.name, file.size, file.lastModified]),
  ])
}

/** The submission for sending `key`: the failed one's again when it is the same question, otherwise new. */
export function nextSubmission(failed: Submission | null, key: string, newId: () => string): Submission {
  return failed?.key === key ? failed : { key, mutationId: newId() }
}
