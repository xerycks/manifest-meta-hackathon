/**
 * JSON text for a jsonb parameter. jsonb cannot hold NUL characters, which
 * source data (MongoDB strings, for one) may contain, so escaped NULs become
 * U+FFFD. A literal backslash followed by "u0000" is left alone.
 */
export function jsonbText(value: unknown): string {
  return JSON.stringify(value).replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1\\ufffd")
}
