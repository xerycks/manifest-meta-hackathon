/**
 * Builds a workspace-scoped API path. Scoped endpoints always carry the
 * workspace id in the path (and the X-Workspace-Id header via apiRequest),
 * so a request can never accidentally read across workspaces.
 */
export function workspacePath(workspaceId: string, subpath: string): string {
  const suffix = subpath.startsWith("/") ? subpath : `/${subpath}`
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}${suffix}`
}
