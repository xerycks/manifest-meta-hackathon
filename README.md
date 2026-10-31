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

Manifest keeps its own data (workspaces, members, sources, manifests, query runs, and
conversations) in a PostgreSQL application database, separate from the databases you connect as
sources.

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
- **Analysis capabilities**: every source in the API carries `capabilities`, which analysis tools
  use for routing and [read queries](#read-queries) enforce: PostgreSQL takes read-only SQL
  `SELECT`s; MongoDB takes read-only `find` and `aggregate` with an allowlist of pipeline stages
  (never `$out`, `$merge`, `$where`, `$function`, or `$accumulator`) and no SQL.
- **Read-only users**: Manifest enforces read-only access itself, but connect with a database user
  that can only read, as the strongest guarantee. For PostgreSQL, a role with `USAGE` on the
  selected schemas and `SELECT` on their tables (`GRANT USAGE ON SCHEMA shop TO manifest_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA shop TO manifest_reader;`); for MongoDB, the `read` role on
  the selected databases.

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

## Read queries

Owners and admins run read queries on a source from its page (**Sources → Edit → Run a read
query**): SQL for PostgreSQL; database, collection, `find` or `aggregate`, and JSON for MongoDB.
The same executor serves later analysis features, and every run is recorded, including refused
ones.

- **PostgreSQL**: exactly one `SELECT`, `VALUES`, `TABLE`, or `WITH … SELECT`, checked with
  PostgreSQL's own parser (libpg_query). Refused: any other statement, a second statement (also
  behind comments), data-modifying `WITH`, `SELECT INTO`, `FOR UPDATE`/`FOR SHARE`, relations
  outside the selected schemas (including `pg_catalog` and `information_schema`), unqualified names
  that are neither a CTE nor a present table or view in the manifest, functions, operators, and
  types qualified with another schema, and functions that act outside the query or read the server
  (`set_config`, `pg_advisory_*`, `dblink*`, `lo_*`, `pg_read_file`, `pg_ls_dir`,
  `pg_terminate_backend`, `pg_notify`, `query_to_xml`, `ts_stat`, …). Allowed queries run in a
  `READ ONLY` transaction with `statement_timeout`, `lock_timeout`,
  `idle_in_transaction_session_timeout`, and `search_path` set to the selected schemas, through the
  extended protocol and a cursor, and are rolled back.
- **MongoDB**: `find` (filter, projection, sort, skip) or `aggregate` (pipeline) on a selected
  database. Values may use relaxed Extended JSON (`{"$date": "…"}`, `{"$oid": "…"}`,
  `{"$numberLong": "…"}`). Stages must be on the allowlist; `$out`, `$merge`, `$where`, `$function`,
  `$accumulator`, and the other forbidden stages are refused at any depth, including inside
  `$lookup`, `$unionWith`, and `$facet`; joins read only collections of the same database, and
  `system.*` collections are refused. Every operation carries `maxTimeMS`, a limit, and
  `allowDiskUse: false`.
- **Limits**: 1,000 rows by default (up to 5,000), 30 s by default (up to 60 s), and 5 MB of rows.
  PostgreSQL rows are read in batches sized to their width; a single response over 8 MB (a huge
  value) stops the query instead of being read into memory.
  At most 2 queries run at once per source, 4 per workspace, and 16 per backend; more get
  `429 QUERY_BUSY` with `Retry-After` instead of waiting.
- **Stopping**: Cancel, closing the request (leaving the page), a timeout, or a backend shutdown
  stops the query on the source, not just the wait: PostgreSQL through `pg_cancel_backend` from a
  separate session (the connection is then discarded), MongoDB through `killOp`. Runs end as
  `succeeded`, `failed`, `timed_out`, `cancelled`, or `rejected` (`422 QUERY_REJECTED` with the
  reason and the offending name).
- **Records**: every run keeps its query, limits, outcome, and up to 1,000 rows (2 MB) of its result
  as evidence. Any member can open a run by id; the 200 most recent runs per workspace are kept,
  plus every run an answer cites, and a backend restart marks runs it left running as failed.

**Result format** (the same for every engine): `{ columns: [{ name, type, kind }], rows, rowCount,
truncated, truncatedBy, durationMs }`. Rows are arrays in column order, so duplicate names
(`SELECT a.id, b.id`) survive. `kind` is one of `integer`, `decimal`, `float`, `text`, `boolean`,
`datetime`, `date`, `time`, `json`, `binary`, `id`, or `unknown`, and `type` is the engine's own
name (`numeric`, `objectId`, or `int | string` for a mixed MongoDB field). `bigint`, `numeric`,
MongoDB `Long`, and `Decimal128` arrive as exact strings; datetimes as ISO 8601; binaries as
`\x`-prefixed hex; ObjectIds as hex; nested documents and json as JSON text. `null` is SQL NULL
or a MongoDB null, and `{"$missing": true}` marks a field a MongoDB document does not have.
`truncatedBy` says whether the row limit (`rows`) or the 5 MB limit (`bytes`) cut the result.

| Route (under `/api/v1/workspaces/:workspaceId/connections/:connectionId`) | Who | |
| --- | --- | --- |
| `POST /queries` `{id, query, maxRows?, timeoutMs?}` | owners, admins | Runs a query; `id` is a new uuid chosen by the client |
| `POST /queries/:executionId/cancel` | who started it, owners, admins | Stops a running query |
| `GET /queries?limit=` | owners, admins | Recent runs, newest first, without rows |
| `GET /queries/:executionId` | members | One run with its stored result |

## Questions (agent runtime)

Any member can ask a question in plain language on **Ask** (`/ask`; a conversation stays at
`/ask/:conversationId`). A background run gives the model the workspace's name and description,
the sources in scope (engine, status, what queries each accepts, and an outline of schemas,
tables, and collections with their labels and row meaning), and the knowledge base titles. The
model then works with eight tools: `list_sources`, `search_metadata` (only the question's sources
count toward its 10 hits), `describe_object` (columns, units, value notes, relationships; only in
the schemas or databases the source reads now), `read_knowledge`, `run_query` (the
[read query](#read-queries) executor, recorded with origin `agent`), `read_attachment`,
`ask_user`, and `submit_answer`. The answer is Markdown plus evidence: the executions behind its
numbers, each with its query, columns, and first 20 rows. It is `partial` with a list of what is
missing when the data cannot answer it.

- **The ask screen**: write a question (Enter sends, Shift+Enter starts a new line), choose the
  sources (all by default), and attach files. Progress streams in as collapsible steps with the
  text the model writes while working; the answer appears as Markdown with its evidence: each
  cited query (SQL, or MongoDB as JSON) with a copy button, its first rows in the result table
  (exact numbers, `NULL` and missing fields labelled), and a link to the stored query run
  (`/sources/:connectionId/queries/:executionId`, which any member can open). The screen shows
  which model answered (the demo model is marked synthetic), Stop cancels the question, a failed
  question can be asked again, and follow-up questions continue the conversation. Status changes
  are announced to screen readers. If the connection drops (or goes silent for 40 seconds), the
  screen says it is reconnecting, catches up from the last event it received, and carries on
  without repeating anything; a question that finished meanwhile shows how it ended. Once a
  question ends, its answer (or error) replaces the text streamed while working, so the answer
  shows once, the same as after a reload.
- **Conversations**: the list beside the chat (a **Conversations** button on narrow screens)
  shows your conversations, newest activity first, with a badge for a question that is running,
  needs your answer, failed, or was interrupted, and more on request. Rename or delete one there
  (deleting asks first, stops its running question, and removes its questions, answers, and
  files). Opening or reloading `/ask/:conversationId` shows the whole history (older questions a
  click away), and a question still being answered picks up its live progress from the last
  stored event. Each question is sent with a `mutationId`, so sending it again after a network
  failure returns the question already started instead of asking twice.
- **Recovery after a restart**: a question a restart (or shutdown) stops while it works becomes
  `interrupted` with a `run.interrupted` event and a `disposition`: `retry` when it only read data
  (every tool so far), so **Retry** asks it again in the same conversation with the same
  sources and files, once; `reconcile` is reserved for later tools with effects, whose outcome
  must be checked before anything is repeated. A question waiting for your answer keeps waiting
  across a restart: it stores its conversation with the model, goes on from there once answered,
  and still stops at its answer deadline. Queries a restart interrupts are marked failed
  (`QUERY_INTERRUPTED`).
- **Streaming**: `GET /runs/:runId/events` is a Server-Sent Events stream: the stored events after
  `?after=` (or the `Last-Event-ID` a reconnecting browser sends), then live ones as they are
  recorded, each with `id` = its sequence number, a heartbeat every 15 seconds (a comment for
  proxies plus a named `heartbeat` event the browser watches for), and the end of the stream after
  the run's last event (a backend shutdown also ends open streams, and the browser reconnects to the
  next process). Text the model streams is recorded every 50 ms or 200 characters, whichever
  comes first; the final answer in `answer.completed` is the one that counts. With Claude Opus 5.5
  the text between tool calls can be sparse, so the screen relies on the tool steps, not on
  streamed text.
- **Clarifications**: when a question is ambiguous in a way that changes the answer, the model can
  ask (`ask_user`: a question, up to six suggested answers, and whether a free-text answer is
  allowed). The run waits with status `awaiting_input` (its own time limit paused) until its owner
  answers with `POST /runs/:runId/answer`, or for `AGENT_ANSWER_TIMEOUT_MS` (default 30 minutes,
  shown as `expiresAt`), after which it fails with `AGENT_INPUT_TIMEOUT`. Cancel works while it
  waits.
- **Files**: a question can carry up to 3 UTF-8 text files (`.csv`, `.tsv`, `.txt`, `.md`,
  `.json`) of up to 256 KB each, sent as base64 in the JSON body. Other types, binary or
  non-UTF-8 content, and larger files are refused with a reason per file. Files are stored with
  the run, listed in it (without their content), and readable by the model for the rest of the
  conversation with `read_attachment`, in slices of up to 12,000 bytes.
- **Providers**: `AGENT_PROVIDER=anthropic` (default) uses Claude through the Anthropic API with
  `ANTHROPIC_API_KEY` and `AGENT_MODEL` (default `claude-opus-5-5`): streamed, adaptive thinking,
  prompt caching, and server-side refusal fallbacks on models that support them.
  `AGENT_PROVIDER=scripted` is a local-only demo model, shown as **demo (synthetic)**: it answers
  net revenue by month, top products, top customers (after asking whether by revenue or by number
  of orders), refund rate, and open tickets on the synthetic PostgreSQL demo source by running
  fixed queries through the real tools, builds its answer only from the returned rows, and says it
  cannot answer anything else (including questions about MongoDB sources). Production refuses it.
  Without a usable provider, the agent endpoints return `503 AGENT_NOT_CONFIGURED`; everything
  else works.
- **Recoverable problems**: invalid tool input, unknown tools, refused or failed queries, removed
  or unreachable sources, sources outside the question's scope, a missing
  `CONNECTION_ENCRYPTION_KEY`, and evidence that does not cite a succeeded query of the same run
  go back to the model as tool errors, so it can fix its call or answer partially.
- **Limits**: `AGENT_MAX_STEPS` model turns (default 12) and `AGENT_RUN_TIMEOUT_MS` per question
  (default 5 minutes); up to 8 tool calls per turn, 2 at a time; agent queries return at most
  1,000 rows in 30 s, and the model sees the first 50 rows within a 12,000-character budget. One
  active question per conversation (`409`), two per user and five per workspace, counting those
  waiting for an answer (`429 AGENT_BUSY` with `Retry-After`), and ten open event streams per user
  (`429 TOO_MANY_STREAMS`). Token usage counts every attempt when a server-side fallback re-runs a
  declined turn.
- **Privacy and records**: conversations and runs are private to the user who asked (others get
  `404`). Follow-up questions in a conversation see up to six earlier questions and answers.
  Each run stores its events, numbered without gaps and each written together with the state change
  it describes, its answer or error, token usage, steps, and a bounded transcript. Executions an
  answer cites are pinned, so history pruning keeps them openable (until their conversation is
  deleted). Cancel, a backend shutdown, and the deadline stop the model and any running query on
  its source. The API key and prompts are never logged.

| Route (under `/api/v1/workspaces/:workspaceId/agent`) | |
| --- | --- |
| `POST /runs` `{question, conversationId?, connectionIds?, attachments?: [{name, content}], mutationId?}` | `202` with the queued run; a new conversation unless `conversationId` is given; `200` with the run already started when `mutationId` was sent before |
| `GET /runs/:runId?after=` | The run with its events (only those after sequence `after`) |
| `GET /runs/:runId/events?after=` | The run's events as Server-Sent Events, live until it ends |
| `POST /runs/:runId/answer` `{answer}` | Answers the run's clarification; `409` unless it is waiting for one |
| `POST /runs/:runId/cancel` | Stops the run and returns it once the cancellation is recorded |
| `POST /runs/:runId/retry` | Asks an interrupted (`retry`) question again: `202` with the new run, `200` with the retry made before |
| `GET /conversations?limit=&cursor=` | Your conversations, newest activity first, with the latest question's status and `nextCursor` |
| `GET /conversations/:conversationId?before=` | The conversation with its latest 50 runs (before run `before`) and their events, and `hasEarlier` |
| `PATCH /conversations/:conversationId` `{title}` | Renames the conversation |
| `DELETE /conversations/:conversationId` | Stops its active question, then deletes it with its runs and files |

Run events, numbered per run: `run.started`, `tool.started {callId, tool, summary}`,
`tool.finished {callId, tool, ok, summary, executionId?}`, `answer.delta {text}`,
`clarification.requested {id, question, options, allowFreeText}`, `clarification.answered {id,
answer}`, `answer.completed {answer}`, `run.failed {code, message}`, `run.cancelled`, and
`run.interrupted {code, message, disposition}`.

## Local demo (synthetic data)

With `DATABASE_URL`, `CONNECTION_ENCRYPTION_KEY`, `ALLOW_DEV_LOGIN=true`, and the demo URLs set
in `backend/.env.local` (add `AGENT_PROVIDER=scripted` to ask questions without an API key):

1. Run `npm --prefix backend run <script>` for `db:seed`, `db:demo-source`, and (for MongoDB)
   `db:demo-mongo`, then start both apps.
2. Sign in as `demo@manifest.local`.
3. On **Sources**, add the demo PostgreSQL database (schemas `shop` and `support`) and the
   MongoDB `manifest_demo` database. Each save starts a metadata refresh.
4. On **Manifests**, browse tables, columns, and foreign keys (or collections and their sampled
   fields), add meaning and manual relationships, write knowledge entries, and search them.
5. On a source's page, run a read query, cancel a slow one (`SELECT pg_sleep(20)`), and reopen
   earlier runs.
6. On **Ask**, ask “What was net revenue by month?” and open its evidence; ask “Who are our top
   customers?” and answer the clarification; ask it again and press Stop while it waits for your
   answer (the demo model answers everything else within a second).
7. Reload the page or reopen a conversation from the list: its questions, answers, and evidence
   are all there. Restart the backend while “Who are our top customers?” waits for your answer,
   then answer it: the question goes on. A question a restart stops while it works shows as
   interrupted with **Retry**.

## Integration tests

Integration tests need throwaway databases; they reset them completely and skip when the
URLs are unset. Source tests also rebuild the synthetic `shop` and `support` schemas. Agent tests
use a scripted model, so they need no API key and make no network calls. MongoDB
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
