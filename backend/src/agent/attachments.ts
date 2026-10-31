import { AppError } from "../shared/http/errors.js"
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES,
  type AttachmentInput,
  type AttachmentMediaType,
} from "./contracts.js"

/** A file checked and ready to store: its name, type, and UTF-8 text. */
export interface DecodedAttachment {
  name: string
  mediaType: AttachmentMediaType
  sizeBytes: number
  content: string
}

const ACCEPTED = Object.keys(ATTACHMENT_TYPES)
  .map((extension) => `.${extension}`)
  .join(", ")

function mediaTypeOf(name: string): AttachmentMediaType | null {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  return Object.hasOwn(ATTACHMENT_TYPES, extension)
    ? ATTACHMENT_TYPES[extension as keyof typeof ATTACHMENT_TYPES]
    : null
}

/** Why a file cannot be used, or its decoded text. */
function decode(input: AttachmentInput): DecodedAttachment | string {
  // Browsers send a bare name, but never keep a path someone typed.
  const name = input.name.split(/[\\/]/).pop()?.trim() || input.name
  const mediaType = mediaTypeOf(name)
  if (!mediaType) return `“${name}” is not a text or CSV file. Attach ${ACCEPTED} files.`
  const bytes = Buffer.from(input.content, "base64")
  if (bytes.length === 0) return `“${name}” is empty.`
  if (bytes.length > ATTACHMENT_LIMITS.bytes) return `“${name}” is larger than 256 KB.`
  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return `“${name}” is not UTF-8 text. Save it as UTF-8 and attach it again.`
  }
  if (content.includes("\u0000")) return `“${name}” looks like a binary file, not text.`
  // A leading byte-order mark is dropped by the decoder, so measure what is kept.
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes === 0) return `“${name}” is empty.`
  return { name, mediaType, sizeBytes, content }
}

/** Checks every file of a question; any unusable one refuses the question with a reason per file. */
export function decodeAttachments(inputs: AttachmentInput[]): DecodedAttachment[] {
  const decoded = inputs.map(decode)
  const problems = decoded.flatMap((result, index) =>
    typeof result === "string" ? [{ index, message: result }] : [],
  )
  if (problems.length > 0) {
    throw AppError.validation(problems.map((problem) => problem.message).join(" "), {
      attachments: problems,
    })
  }
  return decoded as DecodedAttachment[]
}

/** True for the bytes that continue a multi-byte UTF-8 character. */
const continues = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80

/**
 * Up to `maxBytes` bytes of `text` from byte `offset`, moved to whole
 * characters at both ends, and where the next slice starts (null at the end).
 */
export function textSlice(
  text: string,
  offset: number,
  maxBytes: number,
): { text: string; offset: number; nextOffset: number | null } {
  const bytes = Buffer.from(text)
  let start = Math.min(offset, bytes.length)
  while (continues(bytes[start])) start += 1
  let end = Math.min(start + maxBytes, bytes.length)
  while (end > start && continues(bytes[end])) end -= 1
  return {
    text: bytes.subarray(start, end).toString("utf8"),
    offset: start,
    nextOffset: end < bytes.length ? end : null,
  }
}
