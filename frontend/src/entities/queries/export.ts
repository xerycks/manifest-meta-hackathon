import { buildUrl } from "../../shared/api/client.ts"
import { workspacePath } from "../../shared/api/workspace-scope.ts"

/** Where a stored result downloads as CSV (any run a member may open). */
export function csvExportHref(workspaceId: string, connectionId: string, executionId: string): string {
  return buildUrl(
    workspacePath(
      workspaceId,
      `/connections/${encodeURIComponent(connectionId)}/queries/${encodeURIComponent(executionId)}/export.csv`,
    ),
  )
}

/**
 * "monthly-net-revenue-2026-10-31.csv": the name in lowercase words, the
 * run's day, and "-partial" when the file holds fewer rows than matched.
 */
export function csvFileName(name: string, createdAt: string, partial: boolean): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  return `${slug || "query"}-${createdAt.slice(0, 10)}${partial ? "-partial" : ""}.csv`
}
