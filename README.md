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
- Optional: a local MongoDB server for the MongoDB demo data and integration tests

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

Copy `backend/.env.example` to `backend/.env.local` for local settings; it lists and explains
every backend variable. Real environment files and credentials are never committed; only
`.env.example` files are tracked.

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
`503 STORAGE_NOT_CONFIGURED`.

## Authentication

Manifest uses server-side browser sessions (HttpOnly cookie + per-session CSRF token).
Workspaces are only visible to their members; roles are `owner`, `admin`, and `member`.
Workspace creation makes the creator its owner, and owners/admins manage workspace settings.

- **Google sign-in** (identity only: `openid email profile`): set `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` in `backend/.env.local` and register the redirect URI
  `http://127.0.0.1:3001/api/v1/auth/google/callback` (or set `GOOGLE_REDIRECT_URI`).
  Google file access is a separate authorization in a later cycle.
- **Local development sign-in**: set `ALLOW_DEV_LOGIN=true` to sign in with an email form.
  It is ignored in production. After `db:seed`, `demo@manifest.local` owns the demo workspace.
- **Sessions**: set a stable `SESSION_SECRET` (`openssl rand -hex 32`). It is required in
  production; locally an ephemeral secret is generated and sessions reset on restart.

Note: workspaces created before authentication existed have no members and stay hidden
until an owner is assigned (re-running `db:seed` assigns the synthetic demo user).

## Sources

Owners and admins connect PostgreSQL and MongoDB databases on the **Sources** page: enter the
settings, test them, choose the schemas (MongoDB: databases) Manifest may read, and save.
Members see the list read-only.
Saving always runs a connection test first, and failures come back with a reason
(`auth_failed`, `database_not_found`, `host_unreachable`, `timeout`, `tls_failed`, `unknown`)
and a plain message.

- **Credentials**: set `CONNECTION_ENCRYPTION_KEY` (`openssl rand -hex 32`) in
  `backend/.env.local` and keep it stable. Passwords are sealed with AES-256-GCM, bound to their
  workspace and source, and never returned by the API or written to logs. Without the key,
  source endpoints return `503 CONNECTIONS_NOT_CONFIGURED`; production requires it.
- **Editing**: leave the password blank to keep the saved one. It is only reused for the same
  host, port, username, and SSL mode, so changing any of those requires typing it again.
- **Limits**: tests use a 5 s connect timeout and 10 s statement timeout; each saved source gets
  a small pool (3 connections, closed when idle, on edit/remove, and on shutdown).
  System schemas (`pg_*`, `information_schema`) are never listed or selectable.
- **Analysis capabilities**: every source in the API carries `capabilities`, which later analysis
  tools use for routing: PostgreSQL takes read-only SQL `SELECT`s; MongoDB takes read-only `find`
  and `aggregate` with an allowlist of pipeline stages (never `$out`, `$merge`, `$where`,
  `$function`, or `$accumulator`) and no SQL.

### MongoDB sources

Choose **MongoDB** when adding a source, then either enter the host, port, database, optional
username and password, authentication database (default `admin`), and whether to use TLS
(certificates are verified), or paste a `mongodb://` or `mongodb+srv://` connection string.

- **Connection strings** are sealed like passwords. The API and the screens only show their hosts
  and database, never the username or password. Leave the field blank while editing to keep the
  saved string. Strings that would make the server read local files or use a proxy
  (`tlsCAFile`, `tlsCertificateKeyFile`, `tlsCRLFile`, `proxyHost`), or sign in with anything but
  a username and password (AWS, OIDC, Kerberos, X.509), are refused.
- **Editing**: a saved password is only reused for the same host, port, username,
  authentication database, and TLS setting.
- **Databases** take the place of schemas. `admin`, `local`, and `config` are never offered. A user
  who may not list databases is offered the database named in the settings or connection string.
- **Limits**: 5 s to find and connect to the server, 10 s server time (`maxTimeMS`) for every
  command, at most 3 connections per saved source and 20 open clients per backend.

### Synthetic demo source

A deterministic online coffee-and-tea store (synthetic) for demos: schema `shop` (customers,
products, orders, order items over the last ~18 months, with cancellations, refunds, a holiday
rush, and a refund spike from a stale batch) and schema `support` (agents and tickets with
priorities and response/resolution times). Dates are relative to the day you build it.

```sh
createdb manifest_demo_source
# in backend/.env.local: DEMO_SOURCE_DATABASE_URL=postgres://USER@localhost:5432/manifest_demo_source
npm --prefix backend run db:demo-source   # drops and rebuilds only the shop and support schemas
```

Then add a source with host `localhost`, port `5432`, database `manifest_demo_source`, your
local user, and SSL mode **Disable** (local servers usually have no TLS).

### Synthetic MongoDB demo data

Storefront web analytics for the same store (synthetic), in the `manifest_demo` database:
`sessions` (2,500 visits; anonymous visits have no `customer_id`, open ones no `ended_at`),
`web_events` (about 15,000 clickstream events with nested carts, and a tracker version that is a
number for older events and text for newer ones), `product_reviews` (1,200 reviews; imported legacy
reviews store `rating` as text), and a `product_ratings` view. `customer_id` and `product_id` match
`shop.customers.id` and `shop.products.id` in the PostgreSQL demo source.

```sh
# in backend/.env.local: DEMO_MONGO_URL=mongodb://127.0.0.1:27017
npm --prefix backend run db:demo-mongo   # drops and rebuilds only those collections and the view
```

Then add a MongoDB source with host `127.0.0.1`, port `27017`, database `manifest_demo`, no
username, and TLS off.

## Manifests

Manifest reads each source's catalog for its selected schemas: tables, views, materialized
views, partitioned and foreign tables, their columns (type, nullability, default, primary key,
enum values, source comment), and the foreign keys between them. Every member can browse and
search them on the **Manifests** page; owners and admins start and cancel refreshes.

For MongoDB, a refresh lists the collections and views of the selected databases and samples up
to 200 documents from each (`$sample`, or the first documents where `$sample` is unavailable),
reading at most 16 MB per collection. Fields are listed by dotted path (`cart.items.sku`), nested
up to 6 levels and at most 500 per collection, each with every BSON type seen and how often
(`int 92%, string 3%, missing 5%`), the element types of arrays, and the estimated document
count. Descriptions in a collection's `$jsonSchema` validator show as source comments. Fields are
inferred from a sample, so a rare field may be missing from it; a field not seen by the latest
refresh shows as **Not in latest sample** and keeps its meaning. A collection that cannot be
sampled (no permission, or too slow) keeps the fields from its last sample and says why. MongoDB
declares no relationships, so link collections with manual relationships (an array of ids can
refer to an id field).

- **Refreshes** run in the background with live progress. Saving a new source, or changing its
  schemas or connection settings, starts one automatically. A refresh collects everything first
  and publishes it in one transaction, so a failed or cancelled refresh leaves the previously
  published metadata untouched. Cancelling also cancels the query running on the source.
- **Stable identities**: tables, views, columns, and foreign keys keep their ids across
  refreshes. Anything that disappears is marked removed (never deleted) and comes back with the
  same id, so meaning added to it later stays attached.
- **Limits**: one refresh per source at a time and three per backend; per refresh at most 2,000
  tables and views, 50,000 columns, and 10,000 foreign keys, and 3 minutes in total; 30 s per
  catalog query and 10 s waiting for a locked table. Partitions are read through their parent,
  and only foreign keys between selected schemas are kept. Sources need PostgreSQL 12 or later.
- A backend restart marks refreshes the previous process left running as failed.

## Meaning and knowledge base

Owners and admins describe what the data means right on the **Manifests** pages; every member
reads it. Tables and views get a label, what one row represents, and a Markdown description
(with a Write/Preview editor); columns get a label, unit, Markdown description, and allowed or
example values. Foreign keys can carry a remark, and manual relationships record links the
database does not declare: both columns must belong to the same source, still be present, and
hold comparable types (numbers with numbers, text with text, and so on).

- **Survives refreshes**: refreshes only write discovered metadata, so authored meaning stays on
  the same table and column ids. Anything that disappears from the source keeps its meaning and
  shows as removed; a manual relationship whose column disappears is flagged **Needs review**
  rather than deleted, and recovers when the column comes back.
- **Concurrent edits**: every save names the version it started from. If someone saved in the
  meantime, the save is rejected (`409 CONFLICT` with the current record) and the editor shows
  their version next to your draft: save yours on top of it (fields you did not change take
  their value) or use theirs. A failed save keeps the editor open with what you typed.
- **Knowledge base** (**Manifests → Knowledge base**): business definitions such as "active
  customer" or "net revenue", written in Markdown and optionally linked to a source. Any member
  adds entries and edits their own; owners and admins edit or delete any entry. Terms are unique
  per workspace, and removing a source keeps its entries without the link.
- **Search**: the search box on the Manifests page finds tables, views, and columns by name,
  label, or description, and knowledge entries by term or text, across the workspace's sources
  (up to 20 results of each kind; Enter opens the first).
- **Limits**: descriptions up to 20,000 characters, knowledge entries up to 50,000; at most 1,000
  manual relationships per source and 2,000 knowledge entries per workspace. Knowledge and
  search need only application storage; editing manifests needs `CONNECTION_ENCRYPTION_KEY`, like
  browsing them.

## Local demo (synthetic data)

With `DATABASE_URL`, `CONNECTION_ENCRYPTION_KEY`, `ALLOW_DEV_LOGIN=true`, and the demo URLs set
in `backend/.env.local`:

1. Run `npm --prefix backend run <script>` for `db:seed`, `db:demo-source`, and (for MongoDB)
   `db:demo-mongo`, then start both apps.
2. Sign in as `demo@manifest.local`.
3. On **Sources**, add the demo PostgreSQL database (schemas `shop` and `support`) and the
   MongoDB `manifest_demo` database. Each save starts a metadata refresh.
4. On **Manifests**, browse tables, columns, and foreign keys (or collections and their sampled
   fields), add meaning and manual relationships, write knowledge entries, and search them.

## Integration tests

Integration tests need throwaway databases; they reset them completely and skip when the
URLs are unset. Source tests also rebuild the synthetic `shop` and `support` schemas. MongoDB
tests need a disposable MongoDB server: they create and drop `manifest_it_*` databases and a
`manifest_it_reader` user on it.

```sh
createdb manifest_test
createdb manifest_source_test
TEST_DATABASE_URL=postgres://USER@localhost:5432/manifest_test \
TEST_SOURCE_DATABASE_URL=postgres://USER@localhost:5432/manifest_source_test \
TEST_MONGO_URL=mongodb://127.0.0.1:27017 \
  npm --prefix backend run test:integration
```

## Verification

```sh
npm run typecheck
npm run build
npm run test
```
