import { UsersRepository } from "../auth/repository.js"
import { loadEnv } from "../config/env.js"
import { createPool } from "../shared/postgres/client.js"
import { WorkspacesRepository, WorkspaceSettingsRepository } from "../workspaces/repository.js"
import { runMigrations } from "./migrations.js"

// Synthetic local demo data only. Refuses to run outside local development.
const env = loadEnv()
if (env.NODE_ENV === "production") {
  console.error("Seeding is disabled in production.")
  process.exit(1)
}
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy backend/.env.example to backend/.env.local first.")
  process.exit(1)
}

const pool = createPool(env.DATABASE_URL)
try {
  await runMigrations(pool)
  const workspaces = new WorkspacesRepository(pool)
  const settings = new WorkspaceSettingsRepository(pool)

  const existing = (await workspaces.list()).find((workspace) => workspace.slug === "demo")
  const demo =
    existing ?? (await workspaces.create({ slug: "demo", name: "Demo workspace (synthetic)" }))
  await settings.set(demo.id, "description", "Synthetic demo workspace for local development.")

  const demoUser = await new UsersRepository(pool).upsertByIdentity({
    email: "demo@manifest.local",
    name: "Demo user (synthetic)",
  })
  await workspaces.addMember(demo.id, demoUser.id, "owner")

  console.log(
    `Seeded synthetic workspace "${demo.slug}" (${demo.id}), owned by ${demoUser.email} (dev sign-in).`,
  )
} finally {
  await pool.end()
}
