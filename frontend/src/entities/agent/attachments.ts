import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES, type AttachmentInput } from "./types.ts"

const EXTENSIONS = Object.keys(ATTACHMENT_TYPES)

/** For the file picker's accept attribute, e.g. ".csv,.tsv,.txt,.md,.json". */
export const ATTACHMENT_ACCEPT = EXTENSIONS.map((extension) => `.${extension}`).join(",")

/** "Up to 3 text or CSV files (.csv, .tsv, .txt, .md, .json), 256 KB each." */
export const ATTACHMENT_HINT = `Up to ${ATTACHMENT_LIMITS.perRun} text or CSV files (${EXTENSIONS.map((extension) => `.${extension}`).join(", ")}), ${ATTACHMENT_LIMITS.bytes / 1024} KB each.`

/** "980 bytes", "12.4 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString("en-US")} byte${bytes === 1 ? "" : "s"}`
  return `${(bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KB`
}

/** The part of File the checks need. */
export interface PickedFile {
  name: string
  size: number
}

/** Why a file cannot be attached next to those already `attached`, or null when it can. */
function problemWith(file: PickedFile, attached: PickedFile[]): string | null {
  const extension = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ""
  if (!EXTENSIONS.includes(extension)) return `“${file.name}” is not a text or CSV file.`
  if (file.size === 0) return `“${file.name}” is empty.`
  if (file.size > ATTACHMENT_LIMITS.bytes) return `“${file.name}” is larger than 256 KB.`
  if (file.name.length > ATTACHMENT_LIMITS.nameChars) return `“${file.name}” has too long a name.`
  if (attached.some((other) => other.name === file.name && other.size === file.size)) {
    return `“${file.name}” is already attached.`
  }
  if (attached.length >= ATTACHMENT_LIMITS.perRun) {
    return `Attach at most ${ATTACHMENT_LIMITS.perRun} files; “${file.name}” was left out.`
  }
  return null
}

/**
 * Adds picked files to those already attached, keeping the ones that fit the
 * limits and saying why the others do not. Checked again by the server.
 */
export function addFiles<T extends PickedFile>(
  current: T[],
  picked: T[],
): { files: T[]; problems: string[] } {
  const files = [...current]
  const problems: string[] = []
  for (const file of picked) {
    const problem = problemWith(file, files)
    if (problem) problems.push(problem)
    else files.push(file)
  }
  return { files, problems }
}

/** A file's bytes in base64, as the API takes them. */
export async function encodeFile(file: Blob & { name: string }): Promise<AttachmentInput> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return { name: file.name, content: btoa(binary) }
}
