import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Pool } from "pg"

const ADVISORY_LOCK_KEY = 727_001

export function resolveMigrationsDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(process.cwd(), "migrations"),
    path.resolve(moduleDir, "../../migrations"),
    path.resolve(moduleDir, "../../../migrations"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`Migrations directory not found (looked in: ${candidates.join(", ")})`)
}

export interface MigrationFile {
  name: string
  sql: string
}

export function listMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort()
    .map((file) => ({ name: file, sql: readFileSync(path.join(dir, file), "utf8") }))
}

/** Applies pending migrations in filename order, each in its own transaction. Safe to rerun. */
export async function runMigrations(pool: Pool, dir = resolveMigrationsDir()): Promise<string[]> {
  const migrations = listMigrations(dir)
  const client = await pool.connect()
  const appliedNow: string[] = []
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY])
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations")
    const applied = new Set(rows.map((row) => row.name))

    for (const migration of migrations) {
      if (applied.has(migration.name)) continue
      await client.query("BEGIN")
      try {
        await client.query(migration.sql)
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name])
        await client.query("COMMIT")
        appliedNow.push(migration.name)
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }
    }
    return appliedNow
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {})
    client.release()
  }
}
