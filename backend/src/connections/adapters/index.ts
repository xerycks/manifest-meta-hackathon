import type { SourceSettings } from "../schemas.js"
import { createMongoAdapter } from "./mongodb.js"
import { createPostgresAdapter } from "./postgres.js"
import type { SourceAdapter, SourceAdapters } from "./types.js"

/** Pools and clients open lazily, so creating the adapters is free until a saved source is used. */
export function createSourceAdapters(): SourceAdapters {
  return { postgres: createPostgresAdapter(), mongodb: createMongoAdapter() }
}

export async function closeSourceAdapters(adapters: SourceAdapters): Promise<void> {
  await Promise.all(Object.values(adapters).map((adapter) => adapter.close()))
}

/** Calls `use` with the adapter for the source's engine and its settings, typed together. */
export function withAdapter<T>(
  adapters: SourceAdapters,
  settings: SourceSettings,
  use: <Config>(adapter: SourceAdapter<Config>, config: Config) => T,
): T {
  return settings.engine === "postgres"
    ? use(adapters.postgres, settings.config)
    : use(adapters.mongodb, settings.config)
}
