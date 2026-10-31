import { Download } from "lucide-react"
import { useState } from "react"

import { unwrapEnvelope } from "@/shared/api/client.ts"
import { apiErrorMessage } from "@/shared/lib/draft.ts"

import { csvExportHref, csvFileName } from "./export.ts"

/** Saves a downloaded file under `fileName` through a temporary link. */
function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  // Some browsers read the file after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Downloads a run's stored rows as CSV, exactly as its result table shows
 * them, under a name that says what, when, and whether it is partial. A
 * download that fails says why instead of saving the error as a file.
 */
export function CsvDownloadButton({
  workspaceId,
  connectionId,
  executionId,
  name,
  createdAt,
  partial,
}: {
  workspaceId: string
  connectionId: string
  executionId: string
  /** Names the file, e.g. the saved query or what the evidence supports. */
  name: string
  createdAt: string
  /** The file holds fewer rows than the query matched. */
  partial: boolean
}) {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function download() {
    setDownloading(true)
    setError(null)
    try {
      const response = await fetch(csvExportHref(workspaceId, connectionId, executionId), {
        credentials: "include",
      })
      if (!response.ok) unwrapEnvelope(response.status, await response.json().catch(() => null))
      // The server also says when its stored rows are fewer than the query matched.
      const cut = response.headers.has("X-Manifest-Truncated")
      saveFile(await response.blob(), csvFileName(name, createdAt, partial || cut))
    } catch (caught) {
      setError(caught instanceof TypeError ? "Cannot reach the Manifest API." : apiErrorMessage(caught))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <button
        type="button"
        disabled={downloading}
        onClick={() => void download()}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:opacity-60"
      >
        <Download aria-hidden className="size-3.5" />
        {downloading ? "Downloading CSV…" : `Download CSV${partial ? " (partial)" : ""}`}
      </button>
      {error && (
        <span role="alert" className="text-xs font-medium text-(--danger)">
          Not downloaded: {error}
        </span>
      )}
    </span>
  )
}
