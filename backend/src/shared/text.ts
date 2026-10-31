/**
 * Markdown reduced to readable plain text for excerpts: link and image text
 * kept, markers dropped, whitespace collapsed. Underscores stay because they
 * are far more often part of names like order_items than emphasis.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^\s*(```|~~~).*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>)\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/\*\*|~~|[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Up to `max` characters of `text` around the first case-insensitive match of
 * `query` (or from the start without one), with ellipses where it was cut.
 */
export function snippet(text: string, query: string | null, max = 160): string {
  if (text.length <= max) return text
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  const centered = at < 0 ? 0 : at - Math.floor((max - (query?.length ?? 0)) / 2)
  const start = Math.max(0, Math.min(centered, text.length - max))
  const end = start + max
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`
}
