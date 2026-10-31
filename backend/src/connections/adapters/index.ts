import { createPostgresAdapter } from "./postgres.js"
import type { SourceAdapters } from "./types.js"

/** Pools open lazily, so creating the adapters is free until a saved source is used. */
export function createSourceAdapters(): SourceAdapters {
  return { postgres: createPostgresAdapter() }
}

export async function closeSourceAdapters(adapters: SourceAdapters): Promise<void> {
  await Promise.all(Object.values(adapters).map((adapter) => adapter.close()))
}
