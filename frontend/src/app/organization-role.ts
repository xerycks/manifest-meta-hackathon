export type WorkspaceRole = "owner" | "admin" | "member"

export const roleLabels: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
}

/** Owners and admins manage workspace-level state; members work read/write inside it. */
export function managesWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return role === "owner" || role === "admin"
}
