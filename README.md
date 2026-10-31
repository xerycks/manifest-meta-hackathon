# Manifest

Manifest connects data sources, documents what their tables and columns mean, answers questions
with the queries and rows behind every answer, and turns answers into saved queries, dashboards,
and scheduled routines.

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

Manifest keeps its own data (workspaces, members, sources, manifests, query runs, conversations,
saved queries, dashboards, and routines) in a PostgreSQL application database, separate from the
databases you connect as sources.

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
  extended protocol and a cursor, and are rolled back. A query may carry `params` (at most 100
  values of up to 1,000 characters, 50 KB together), bound to `$1..$n` by position and never
  written into the SQL; the SQL must use each of them and no others (the agent's `run_query` takes
  queries without them, so evidence shows, exports, and saves its query as written).
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
  plus every run an answer cites and each saved query's latest result, and a backend restart marks
  runs it left running as failed.

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

## Saved queries and exports

Any member turns a useful query into a saved query: **Save as query** on an answer's evidence
(prefilled with what it supports, its source, and its query; the answer is kept as its origin) or,
for owners and admins, from a source's query console. A saved query has a name (unique per
workspace), a Markdown description, its source and query, optional date parameters, and a
visibility: everyone in the workspace, or only its creator (others get `404`). Everyone it is
visible to reopens it at `/saved/:savedQueryId` and runs it; its creator or an owner or admin
edits or deletes it. Private hides the saved query itself (its definition, list and search entry,
run route, and run history); its runs are query runs like any other, so, as with an answer's
evidence, a member who has a run's id can open or export it, and owners and admins see it in the
source's query history. Names are unique across private ones too, so a `409` tells that a name is
taken without showing the saved query. Saving checks the query with the source's validators
without running it, and edits name the version they started from (`409 CONFLICT` with the current
record when someone saved in between; the editor keeps your draft).

- **Reruns carry today's permissions**: every run goes through the [read query](#read-queries)
  executor as the person running it (origin `saved_query`), so the source's current schemas,
  validators, limits, and admission apply (`429 QUERY_BUSY` passes through). A deselected schema
  gives `422 QUERY_REJECTED` naming the table; removing a source removes its saved queries.
- **Date parameters**: `date` or `datetime` parameters with a fixed default (`2026-10-01`,
  `2026-10-01T09:30`) or a relative one (`today`, `yesterday`, `start_of_week` (Monday),
  `start_of_month`, `start_of_quarter`, `start_of_year`, `days_ago:N`, `months_ago:N`), resolved
  when the query runs in the workspace time zone (**Settings → Time zone**, UTC by default). A
  datetime parameter starts at its day's first instant there (DST gaps move forward, repeated
  times take the first) and is sent with that offset; a `date` parameter is sent as a calendar
  date, which PostgreSQL compares with a `timestamptz` column at midnight in the source session's
  time zone, so use `datetime` parameters for timestamps. SQL writes them as `{{name}}`, sent as
  bind parameters (`$1..$n`), never written into the SQL (a saved query cannot carry `params` of
  its own); MongoDB writes `{"$param": "name"}` in filter or pipeline values, replaced
  by dates. Unknown, unused, missing, or invalid parameters give `422 INVALID_PARAMETERS` naming
  them. Every run returns and records the values it resolved to. Queries that read the database
  clock (`now()`, `current_date`, `$$NOW`, …) save with a warning, since their rows depend on when
  they run and on the source's time zone.
- **Results and history**: the latest succeeded run stays pinned, so its stored result opens with
  the saved query; the run history lists every run with its parameter values (older runs follow
  the workspace's history pruning).
- **CSV**: any run a member may open (console, evidence, saved query) downloads as CSV with
  `GET …/connections/:connectionId/queries/:executionId/export.csv`: the stored rows in result
  column order, RFC 4180 with CRLF and a UTF-8 byte order mark, exact numbers and ISO dates as
  stored, empty cells for `NULL` and missing MongoDB fields, and text starting with `=`, `+`, `-`,
  `@`, a tab, or CR prefixed with `'` so spreadsheets do not run it (plain numbers such as `-12.50`
  stay as they are). A result cut by its row or size limit, or by the stored snapshot, sends
  `X-Manifest-Truncated` (`rows`, `bytes`, `snapshot`) and a `-partial` file name. **Download
  CSV** in the app names the file after the saved query or evidence and its day, and a download
  that fails says why instead of saving the error.
- **Answers as Markdown**: `GET …/agent/runs/:runId/export.md` downloads an answer (its text, what
  the data could not tell, and each cited query with its rows) for the user who asked.

| Route (under `/api/v1/workspaces/:workspaceId/saved-queries`) | |
| --- | --- |
| `GET /?search=&connectionId=&limit=&offset=` | Saved queries you may see, with `nextOffset` |
| `POST /` `{name, description?, connectionId, query, parameters?, visibility?, origin?}` | `201` with the saved query |
| `GET /:id` | The saved query with its resolved defaults, warnings, time zone, and `latestRun` |
| `PATCH /:id` `{version, name?, description?, query?, parameters?, visibility?}` | Creator, owners, admins |
| `DELETE /:id` | Creator, owners, admins |
| `POST /:id/run` `{parameters?: {name: value}}` | `{execution, parameters, timeZone}` |
| `GET /:id/runs?limit=&offset=` | Its runs, newest first, with `nextOffset` |

## Dashboards

A dashboard is a named set of panels on a 12-column grid (at most 30 panels; a workspace has at
most 200 dashboards, with names unique regardless of case). Any member creates one on
**Dashboards** or with **Add to dashboard** on a saved query. Like saved queries, a dashboard is
visible to everyone in the workspace or only to its creator: a private dashboard is `404` for
everyone else, workspace owners and admins included. Its creator or an owner or admin renames it,
edits its Markdown description and visibility, adds, edits, duplicates, moves, resizes, and removes
panels, and deletes it; other members view and refresh it. Edits name the version they started
from (`409 CONFLICT` with the current record).

- **Panels**: a **number** shows one column of the first row (formatted as a number, a currency,
  or a percent of a ratio, with up to 10 decimal places), and optionally its difference from a
  comparison column; numerics are formatted from their exact digits, never through a float. A
  **table** shows the result's columns, or a chosen subset in a chosen order. A **Markdown** panel
  shows up to 4,000 characters of text. A **bar** or **line** chart plots up to 5 columns of
  values against an x column (bars side by side or stacked, in result order, by x, or by value; a
  line follows a date or number axis), a **gauge** shows one value between a minimum and a maximum
  with up to 4 good, warning, or critical thresholds, a **ticker** shows a row of labelled values
  with an optional change, and a **Sankey** diagram draws flows from a source column to a target
  column as wide as a value column. Columns a panel names must be in the saved query's latest
  result when it has one (`422` naming the column; values must be columns of numbers). Every chart
  has a summary for screen readers, exact values in its tooltips, and **View as table**.
- **Layout**: editors drag a panel by its handle and resize it from its corner, or focus the handle
  and use the arrow keys (Shift resizes); panels in the way move down and gaps close up. Each kind
  has a minimum size, and new panels go below the others. Every change saves the whole layout with
  its own `layoutVersion`: overlapping, off-grid, or too-small boxes get `422`, and a stale version
  or a changed set of panels gets `409`. On a narrow screen (under 640 px) the panels stack in one
  column, top to bottom and then left to right, and do not move.
- **Results**: query panels show their saved query's latest succeeded run (its pinned stored
  result), when it ran, and the parameter values it ran with, since a routine or a rerun may have
  used values other than the defaults. A panel carries only what it shows: 1 row for a number or
  gauge, 100 for a table (128 KB), 50 for a ticker (128 KB), and 1,000 for a bar, line, or Sankey
  chart (256 KB). Bar charts draw the 25 largest categories plus “Other” and Sankey diagrams the 50
  largest flows (loops left out), with a note saying so, as for a result the query's own row limit
  cut. Dashboards read stored results only, so they open without `CONNECTION_ENCRYPTION_KEY`.
- **Refresh**: **Refresh all** (with progress and **Cancel refresh**) or a panel's **Refresh** runs
  the saved queries with their defaults as the person refreshing (origin `dashboard`, so the
  source's validators, limits, and admission apply). Each saved query runs once however many
  panels, dashboards, or viewers ask for it meanwhile, and a refresh runs 2 at a time; `429
  QUERY_BUSY` is retried with backoff for up to a minute, and cancelling stops only the runs no
  other refresh still waits for. Refresh all skips Markdown panels, removed or private saved
  queries, and saved queries that need parameter values (**Run with values** opens their page).
  Each panel says whether it is fresh, refreshing, failed (and why), or cancelled; a failed panel
  keeps its last good result. Refreshes are coordinated within one backend process.
- **Saved queries and privacy**: a panel uses a saved query its editor can see, and a private
  saved query only on a private dashboard. If a saved query is made private later, its panels show
  that it is private to everyone but its creator, without its name, id, or rows. Deleting a saved
  query, or the source it reads, keeps its panels, which then say the saved query was removed until
  someone picks another one or removes them.

| Route (under `/api/v1/workspaces/:workspaceId/dashboards`) | |
| --- | --- |
| `GET /` | Dashboards you may see, recently updated first, with panel counts |
| `POST /` `{name, description?, visibility?}` | `201` with the dashboard |
| `GET /:id` | The dashboard with its panels, each query panel's latest result and status, and any refresh under way |
| `PATCH /:id` `{version, name?, description?, visibility?}` | Creator, owners, admins |
| `DELETE /:id` | Creator, owners, admins; the saved queries stay |
| `POST /:id/panels` `{kind, title?, savedQueryId?, config}` | `201` with the panel, placed below the others |
| `PATCH /:id/panels/:panelId` `{version, kind?, title?, savedQueryId?, config?}` | The panel, checked as a whole |
| `DELETE /:id/panels/:panelId` | Removes the panel |
| `PUT /:id/layout` `{version, boxes: [{panelId, x, y, w, h}]}` | Every panel once; the dashboard with its new `layoutVersion` |
| `GET /:id/refresh` | Whether a refresh is under way, and each panel's status |
| `POST /:id/refresh` `{panelIds?}` | `202`: refreshes every panel, or the ones listed, joining a refresh under way |
| `DELETE /:id/refresh` | Cancels the refresh once its runs have stopped |

## Routines

A routine runs a saved query (with values for its date parameters) or asks a question, on a
schedule and on demand, as its owner: the member who created it. Any member creates routines on
**Routines** or with **Create routine** on a saved query, and sees every routine of the workspace
and how its runs went; the owner or a workspace owner or admin edits, pauses, resumes, runs, and
deletes it (others get `403`, non-members `404`). A workspace has at most 100 routines, with names
unique regardless of case. Results stay in Manifest (`delivery: {channel: "in_app"}`).

- **Schedules** are 5-field cron (minute, hour, day of month, month, day of week) read in an IANA
  time zone, the workspace's unless chosen, and described in plain words. Runs must be at least
  `ROUTINE_MIN_INTERVAL_MINUTES` apart (default 5). A time that a spring-forward gap skips runs at
  the first minute after it; a time that a fall-back overlap repeats runs once. Relative parameter
  values (“yesterday”) resolve in the routine's time zone when it runs.
- **Dispatch**: every backend claims due routines every `ROUTINE_POLL_INTERVAL_MS` (default 15 s)
  with `SELECT … FOR UPDATE SKIP LOCKED`, records the run for the slot (unique per routine and
  slot), and moves the next run on in the same transaction, then runs at most 4 at a time per
  backend. So several backends on one database never run a slot twice. After downtime a routine
  runs once, for the latest slot that came, and notes the skipped slots in a single skipped run.
  Pausing clears the next run; resuming schedules the next slot after now, without running the
  ones missed.
- **Runs** act as the owner: saved queries through their run route (origin `routine`, so the
  source's validators, limits, and admission apply, and the saved query keeps the result as its
  latest), questions as an agent run in the routine's own conversation (“Routine: name”, marked in
  the Ask list and private to the owner). Nobody can answer a routine's clarification, so asking one
  fails the run. Refused runs (`429`) retry for up to a minute. A run fails with a reason when the
  owner left the workspace, the saved query was deleted or made private by someone else, or a
  source is gone; three failures in a row pause the routine (`pausedReason: "failures"`), as does a
  stored schedule that can no longer be read. Every member sees each run's outcome, but the link to
  the result of a saved query private to someone else only shows to the routine's owner.
- **Restarts**: on shutdown the dispatcher stops claiming before the runners stop; a run they stop
  is `interrupted`. At startup, runs left queued or running become `interrupted` (this assumes all
  backends restart together). Interrupted runs are never retried automatically, so a restart
  repeats no work. Each routine keeps its latest 1,000 finished runs.
- **Run now** takes a client-chosen `mutationId`: sending it again returns the run it started. It
  works while paused and leaves the schedule alone. A backend already running 4 routine runs
  refuses another with `429 ROUTINE_BUSY` (and `Retry-After`), so manual runs cannot crowd out
  scheduled ones.

| Route (under `/api/v1/workspaces/:workspaceId/routines`) | |
| --- | --- |
| `GET /` | Every routine, with its schedule in words, next run, and last status |
| `POST /` `{name, description?, kind, savedQueryId + parameters? \| question + connectionIds?, cron, timeZone?, enabled?}` | `201` with the routine and its next 3 runs |
| `GET /schedule-preview?cron=&timeZone=` | The schedule in words and its next 3 runs, or `422` saying why not |
| `GET /:id` | The routine, its next 3 runs, and (for its owner) its conversation |
| `PATCH /:id` `{version, …}` | Owner, owners, admins; a new schedule moves the next run |
| `POST /:id/pause`, `POST /:id/resume` | Owner, owners, admins |
| `POST /:id/run` `{mutationId}` | `202` with the run (`200` when the id was sent before; `429` when this backend is full) |
| `GET /:id/runs?limit=&offset=` | Runs newest first, with errors and links to the query run or conversation |
| `DELETE /:id` | Deletes the routine and its runs; its conversation stays with its owner |

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
8. On an answer's evidence, choose **Save as query**, add a date and time parameter (for example
   `ordered_at >= {{since}}` with the default “Start of this month”), save, run it with its default
   and with another date, and download its CSV. Set the workspace time zone on **Settings**.
9. On a saved query, choose **Add to dashboard**, name a new dashboard, and add it as a table or
   a number (for example a revenue column as a currency). On the dashboard, add a Markdown note
   and a line or bar chart, drag and resize the panels, change a chart's settings, and reload: the
   layout, the settings, and the results are the same. **Refresh all** runs each saved query once,
   and a panel whose refresh fails keeps its last result. Narrow the window to see the panels
   stack in one column.
10. On a saved query, choose **Create routine**, pick “Every few minutes” (set
    `ROUTINE_MIN_INTERVAL_MINUTES=1` for a quicker demo), and watch its runs appear in the
    history. Pause and resume it, choose **Run now**, and create a question routine for “What is
    the refund rate?”: its answers appear in a “Routine:” conversation on **Ask**.

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
