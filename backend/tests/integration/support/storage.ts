import type { Pool } from "pg"

import { listMigrations, resolveMigrationsDir, runMigrations } from "../../../src/storage/migrations.js"

/** Every migration file name, in the order they apply. */
export function migrationNames(): string[] {
  return listMigrations(resolveMigrationsDir()).map((migration) => migration.name)
}

/**
 * Wipes the throwaway test database completely and applies all migrations,
 * so tables added by later cycles never leak between test files.
 */
export async function resetStorage(pool: Pool): Promise<string[]> {
  await pool.query("DROP SCHEMA public CASCADE")
  await pool.query("CREATE SCHEMA public")
  return runMigrations(pool)
}
