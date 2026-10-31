/** A LIKE/ILIKE pattern that matches `search` literally anywhere in the text. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}
