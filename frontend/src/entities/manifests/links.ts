/** App paths for manifest pages, shared by everything that links into them. */

export function objectHref(connectionId: string, objectId: string): string {
  return `/manifests/${encodeURIComponent(connectionId)}/objects/${encodeURIComponent(objectId)}`
}

/** The element id of a column's row on its object's page. */
export function columnAnchor(columnId: string): string {
  return `column-${columnId}`
}

export function columnHref(connectionId: string, objectId: string, columnId: string): string {
  return `${objectHref(connectionId, objectId)}#${columnAnchor(columnId)}`
}
