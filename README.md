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

## Verification

```sh
npm run typecheck
npm run build
npm run test
```
