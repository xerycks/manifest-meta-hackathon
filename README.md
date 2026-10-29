# Manifest

Manifest connects data sources, documents what their tables and columns mean, and answers
questions with the queries and rows behind every answer.

The repository is a monorepo:

- `frontend/` — React, TypeScript, and Vite
- `backend/` — Express and TypeScript
- `hackathon-sim-plan.md` — the 24-cycle build plan and completion record

## Requirements

- Node.js 22.18+ or 24.11+ (see `.nvmrc`)
- PostgreSQL 14+ for application storage (from Cycle 03)

## Local development

Install both applications:

```sh
npm --prefix backend install
npm --prefix frontend install
```

Start the backend, then the frontend (Vite proxies `/api` and `/health` to the backend):

```sh
npm run dev:backend    # http://127.0.0.1:3001
npm run dev:frontend   # URL printed by Vite, usually http://localhost:5173
```

Copy `backend/.env.example` to `backend/.env.local` for local settings. Real environment
files and credentials are never committed; only `.env.example` files are tracked.

## Application storage

Manifest keeps its own data (workspaces, settings, and later sources and manifests) in a
PostgreSQL application database, separate from the databases you connect as sources.

```sh
createdb manifest
# in backend/.env.local: DATABASE_URL=postgres://USER@localhost:5432/manifest
npm --prefix backend run db:migrate   # also runs automatically at backend startup
npm --prefix backend run db:seed      # optional synthetic demo workspace (local only)
```

Without `DATABASE_URL` the backend still starts, and workspace endpoints return
`503 STORAGE_NOT_CONFIGURED`. Integration tests need a throwaway database:

```sh
TEST_DATABASE_URL=postgres://USER@localhost:5432/manifest_test npm --prefix backend run test:integration
```

## Verification

```sh
npm run typecheck
npm run build
npm run test
```
