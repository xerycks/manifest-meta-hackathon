# Manifest hackathon build plan

## Target outcome

Build Manifest as a cohesive application for connecting data sources, documenting their meaning, asking questions, and turning answers into reusable queries, dashboards, and routines. Support the implemented Google Workspace workflows alongside database analysis.

The plan has **24 build cycles**. Each cycle delivers a bounded, reviewable capability and ends with a runnable application. Cycle numbers describe implementation order, not elapsed hours. Set the event duration before starting; estimate and timebox each cycle after reviewing its dependencies. Integration-heavy cycles may need more time than interface cycles.

## Relative timeline

| Build session | Cycles | Demonstrable outcome |
| --- | --- | --- |
| 1 — Foundation | 01–04 | Frontend and backend run together; users enter an authorized workspace. |
| 2 — Data understanding | 05–08 | PostgreSQL and MongoDB sources expose editable schema manifests. |
| 3 — Core analysis | 09–12 | A user asks a question, receives a grounded answer, and resumes the conversation. |
| 4 — Reusable analysis | 13–16 | Answers become saved queries, dashboards, and scheduled routines. |
| 5 — Workspace workflows | 17–20 | Google accounts, files, Chat, and approved document actions work together. |
| 6 — Operations and delivery | 21–24 | Settings, usage, administration, deployment, and the demo are ready. |

A session is a planning group, not a fixed-length day. Checkpoints at cycles 04, 08, 12, 16, 20, and 24 require a live walkthrough of the cumulative functionality. Record actual time spent and remaining scope at each checkpoint.

## Working structure

Keep one repository with `frontend/` and `backend/`. Use frontend `src/app`, `src/pages`, `src/features`, `src/entities`, and `src/shared` for application wiring, screens, interactions, API contracts, and shared primitives. Group backend code by feature, with a small server composition layer and shared configuration, storage, and HTTP utilities.

Paths below identify implementation areas relative to each application. They are a map for locating related behavior; they do not require reproducing every internal file or layer.

## Method for every cycle

1. Read the relevant implementation, its imports, API contracts, persistence requirements, and behavior checks before starting. Identify dependencies explicitly.
2. Define the smallest complete behavior for the cycle: request, response, persisted state, user action, and expected result. Write any schema change before wiring the screen.
3. Implement backend behavior and its frontend caller together. Add only dependencies needed for this cycle. Keep provider credentials and environment-specific values in local configuration.
4. Integrate the capability into the running application. Validate the success path, a meaningful failure path, and workspace permissions. Use focused automated checks for critical logic and manual checks for interface behavior.
5. Run the relevant build, type, and lint checks. Make a coherent commit describing the delivered behavior. Record completion evidence and unresolved work before starting the next cycle.

Do not pull an entire dependency tree into a cycle to satisfy a single import. Extract the required contract or helper, or move the missing behavior into an earlier dependency cycle. Temporary fixtures must be visibly identified in development and replaced before the capability is marked complete.

## Session 1 — Foundation

### Cycle 01 — Runnable frontend and backend

- **Implement:** React, Vite, and TypeScript in `frontend/`; Express and TypeScript in `backend/`. Add development and build commands, a frontend entry screen, backend `/health`, configuration validation, and `.env.example` files. Choose a supported Node version and record it.
- **Approach:** Establish independent application entrypoints and a local frontend-to-backend connection. Install the baseline toolchain first; add feature libraries in their owning cycles. Resolve the icon package and registry choice before introducing icon imports, keeping registry credentials out of tracked files.
- **Complete when:** A clean dependency installation can start both applications, the frontend receives a health response, and both builds pass.

### Cycle 02 — Application shell and shared API behavior

- **Implement:** Frontend `app/layouts`, `app/router`, `app/providers`, `shared/api`, `shared/styles`, and essential `shared/ui` primitives. Backend `shared/http`, response handling, and server composition.
- **Approach:** Establish navigation, layout, design tokens, query caching, request handling, consistent errors, and route error states. Add primitives as their first screen needs them. Register functional routes as they become available.
- **Complete when:** Navigation and direct URL loading work; a sample backend error renders predictably; keyboard focus and basic narrow-screen layout work.

### Cycle 03 — Storage and workspace boundaries

- **Implement:** Backend configuration, application storage schema, migrations, workspace lookup, and scoped repositories from `tenancy/` and `shared/postgres-client`. Frontend workspace selection and scoped API requests from `app/workspace-session` and `shared/api/workspace-scope`.
- **Approach:** Separate application storage from connected analytical databases. Establish workspace IDs and enforce them in data access before adding feature records. Provide repeatable local setup and synthetic seed data. Any development bootstrap must be explicitly gated to local use.
- **Complete when:** Fresh storage initializes repeatably, data survives a restart, and a scope check demonstrates that one workspace cannot read another workspace's records.

### Cycle 04 — Authentication and access rules

- **Implement:** Backend `auth/browser-session`, Google sign-in routes, organization membership, and role checks. Frontend `app/session-gate`, sign-in/onboarding entry, organization role handling, and session expiry behavior.
- **Approach:** Connect sign-in to the workspace boundary from cycle 03. Introduce the initial owner membership and enforce role checks server-side. Keep Google sign-in distinct from later authorization to access Google files and services.
- **Complete when:** Sign-in, sign-out, session expiry, and workspace entry work. An unauthenticated request and a restricted member action are rejected by the backend.

## Session 2 — Data understanding

### Cycle 05 — PostgreSQL connection management

- **Implement:** Backend `apis/connections` schemas, credential storage, repository, connection service, and PostgreSQL adapter. Frontend `entities/connections`, `features/manage-connections`, and the connections settings screen.
- **Approach:** Deliver connection form → test → schema selection → save → list → retest → remove. Use timeouts, bounded connection pools, and protected credential storage. Keep the adapter boundary small enough to support the next engine.
- **Complete when:** A synthetic PostgreSQL source can be connected and reloaded; invalid credentials produce a useful error; saved secrets are absent from API responses and logs.

### Cycle 06 — PostgreSQL metadata discovery

- **Implement:** Backend manifest discovery and storage under `apis/manifests`, including schemas, tables, columns, relationships, and refresh state. Frontend schema browser and refresh controls.
- **Approach:** Discover metadata for selected schemas, persist stable identities, and expose refresh progress, cancellation, and errors. Keep the last usable metadata available while a refresh runs.
- **Complete when:** A schema with related tables can be browsed; refresh reflects an added column; cancellation or failure leaves previously published metadata usable.

### Cycle 07 — Manifest editing and knowledge base

- **Implement:** Backend manifest editor schemas, repository, table/column patches, and reference operations. Frontend `entities/manifests`, `features/edit-manifests`, manifests page, and knowledge-base entry.
- **Approach:** Add table and column descriptions, Markdown editing, reference browsing, reference edits, and search. Keep user-authored meaning attached to stable metadata identities across refreshes.
- **Complete when:** A user adds business context and a relationship, reloads, refreshes metadata, and sees those edits preserved. Failed saves retain the editor's contents.

### Cycle 08 — MongoDB source support

- **Implement:** Backend MongoDB adapter, discovery, metadata persistence, and source capability definitions. Extend the connection form and manifest browser for document collections and fields.
- **Approach:** Reuse the connection and manifest contracts while preserving MongoDB-specific behavior. Bound document sampling and represent mixed or missing field types honestly. Define which analysis operations each engine supports for later tool routing.
- **Complete when:** A MongoDB source can be connected, sampled, refreshed, and documented through the same workflow. Engine-specific metadata remains understandable, and PostgreSQL still works.

## Session 3 — Core analysis

### Cycle 09 — Controlled query execution

- **Implement:** Backend `queries/` validation, source permissions, execution contracts, admission, timeouts, result limits, cancellation, and execution records. Add the appropriate source-specific execution adapters.
- **Approach:** Build and verify query execution independently of the model. Use constrained source credentials and enforce allowed operations server-side. Create minimal developer verification tooling rather than a separate full query-editor product.
- **Complete when:** Representative PostgreSQL and supported MongoDB read operations return bounded results. Disallowed operations are rejected, and slow queries can time out or be cancelled without leaving orphan work.

### Cycle 10 — Agent runtime and analytical tools

- **Implement:** Backend `agent/config`, harness integration, instructions, source context, metadata tools, query tools, message contracts, and agent routes. Start with one configured model provider and define a provider boundary.
- **Approach:** Add source discovery → manifest lookup → query execution → answer generation. Route every analytical tool through cycle 09 permissions and limits. Reuse shared message contracts for the frontend rather than inventing a second message format.
- **Complete when:** A question against synthetic data produces the expected result with source context and executed-query evidence. Unavailable sources and invalid tool inputs yield recoverable errors.

### Cycle 11 — Ask interface and streamed answers

- **Implement:** Frontend `entities/agent`, `pages/ask`, composer, chat timeline, answer blocks, tables, SQL display, and the reusable chat panel. Backend answer streaming and event delivery.
- **Approach:** Wire the Ask screen to the real agent. Support tool progress, partial answers, final answers, clarification requests, cancellation, and attachments supported by the runtime. Render structured values without losing numeric precision or mislabeling missing data.
- **Complete when:** A user submits a question, watches progress, inspects the result and evidence, responds to a clarification, and cancels another request. Stream failure leaves a clear recoverable state.

### Cycle 12 — Conversation persistence and recovery

- **Implement:** Backend chat routes, agent store, durable execution records, event ordering/replay, waits, and recovery handling. Frontend conversation list/history, thread navigation, and reconnect behavior.
- **Approach:** Persist conversation and execution state with workspace and user access boundaries. Resume event delivery after disconnects. Distinguish retryable reads from actions whose outcome must be reconciled before retrying.
- **Complete when:** A refreshed or reopened chat retains its messages; a disconnected stream resumes without duplicate answers; a backend restart leaves interrupted work in a defined recoverable state.

**Checkpoint:** Demonstrate sign-in → connect a source → edit its meaning → ask a question → inspect evidence → reopen the conversation. This is the first complete core-product demo.

## Session 4 — Reusable analysis

### Cycle 13 — Saved queries and exports

- **Implement:** Backend saved-query routes, execution persistence, date parameters, and CSV export. Frontend `entities/saved-queries`, `features/saved-query`, and saved-query routes. Add supported answer/file export helpers from `agent/` where required.
- **Approach:** Save a useful analytical result with its source and query definition. Support reopening, permitted edits, rerunning, parameter changes, and downloadable results. Carry source permissions into every rerun.
- **Complete when:** An answer becomes a saved query that can be reopened and rerun; parameters behave predictably; exported rows and values match the displayed result.

### Cycle 14 — Dashboard storage and basic panels

- **Implement:** Backend `dashboards/` schemas, panel definitions, and API routes. Frontend `entities/dashboards`, dashboard list/detail pages, and basic number, table, and Markdown panels.
- **Approach:** Establish dashboard creation, naming, ownership/access, panel persistence, and links to query-backed results. Add agent dashboard tools only after direct API behavior works.
- **Complete when:** A user creates a dashboard, adds panels from a saved analysis, reloads it, and sees the same content. Unauthorized dashboard access is rejected.

### Cycle 15 — Dashboard layouts, charts, and refresh

- **Implement:** Frontend `features/dashboard` canvas/layout, panel actions, and supported bar, line, gauge, ticker, and Sankey charts. Backend panel refresh and query execution coordination.
- **Approach:** Add layout persistence, resize/reorder behavior, visualization settings, and refresh states. Reuse the bounded query executor; avoid launching redundant work when several panels refresh together.
- **Complete when:** Layout and chart choices survive reloads; panels refresh correctly; empty, failed, and large results render sensibly; a narrow viewport remains usable.

### Cycle 16 — Scheduled routines

- **Implement:** Backend `routines/`, cron/timezone handling, routine routes, scheduling/dispatch, and run history. Frontend `entities/routines`, `features/manage-routines`, and routine pages.
- **Approach:** Turn a repeatable analysis into a routine with enable/disable, next-run information, manual execution, and visible outcomes. Establish idempotent dispatch and respect working-hour/timezone rules where supported. Persist delivery configuration; connect Google Chat delivery after cycle 19.
- **Complete when:** A routine runs manually and on schedule, can be paused, and records success or failure. Restart and duplicate-dispatch checks do not produce unintended duplicate runs.

## Session 5 — Workspace workflows

### Cycle 17 — Google account authorization and integration setup

- **Implement:** Backend Google scopes, account linking, refresh/revocation handling, and workspace integration configuration. Frontend Google onboarding, account warnings, preferred-account selection, and integration setup screens.
- **Approach:** Request service access separately from sign-in, with explicit consent for the capabilities being enabled. Support multiple linked accounts where the workflows require them, using the selected user's authorized account for each operation.
- **Complete when:** A user links an account, chooses it for the integration, and disconnects it. Missing consent or revoked access leads to a useful reconnect flow.

### Cycle 18 — Google Drive and Sheets sources

- **Implement:** Backend `google-files/` contracts, repository, routes, file lookup, sheet tabs, bindings, and read tools. Frontend `features/edit-google-file-manifests`, file selection, tab selection, and file manifest editing.
- **Approach:** Add permitted Drive file discovery and Sheets reads as sources with documented meaning. Feed their capabilities and metadata into the existing agent context. Preserve file, tab, and range identities rather than relying only on display names.
- **Complete when:** An authorized sheet can be selected, documented, and queried through Ask. A renamed tab, missing range, and inaccessible file produce defined results or useful errors.

### Cycle 19 — Google Chat conversations and delivery

- **Implement:** Backend `integrations/google-chat` provider configuration, verified event routes, routing, subscriptions, origin identity, receipts, and delivery. Frontend Google Chat configuration and diagnostics.
- **Approach:** Map incoming events to the correct workspace, user, space, and conversation. Reuse the agent runtime and authorization boundaries. Connect routine delivery and persist receipt/idempotency state before enabling retries.
- **Complete when:** A permitted direct or space message receives a grounded response in the correct conversation; a routine delivers there; duplicate events do not generate duplicate actions or replies.

### Cycle 20 — Workspace tools, approvals, and sheet feeds

- **Implement:** Google Chat, Gmail, Drive, Docs, and Sheets tools supported by `integrations/google-chat` and `google-files`; sheet edit approvals, feeds, and the associated `apps-script/` handler, client, store, and tooling. Add web approval/status surfaces where required.
- **Approach:** Bring each tool family online separately: authorized reads first, preview/proposal next, approved mutations last. Connect Apps Script feeds with verified requests and durable binding state. Carry action status across the web chat and Google Chat surfaces.
- **Complete when:** Read workflows work with the selected account; a proposed edit can be approved or rejected; revocation blocks subsequent access; retried delivery does not repeat a completed mutation; a sheet feed updates its bound destination once.

**Checkpoint:** Demonstrate a documented sheet or database source, a question from Google Chat, a scheduled delivery, and an approved Workspace action. Track incomplete tool families individually; one passing tool does not complete the whole cycle.

## Session 6 — Operations and delivery

### Cycle 21 — Organization, users, and profile settings

- **Implement:** Backend settings and organization routes, invitations, membership administration, and profile/account behavior. Frontend organization, profile, users, invitations, and account-preference screens.
- **Approach:** Complete member lifecycle and role management on top of cycle 04 authorization. Apply access changes to chats, sources, saved queries, dashboards, routines, and integrations. Surface only settings backed by functioning behavior.
- **Complete when:** An owner invites a member, changes a role, and removes access. The backend enforces the changed permissions, and an expired or previously used invitation is handled correctly.

### Cycle 22 — Provider configuration, usage, and limits

- **Implement:** Backend provider adapters, organization AI configuration, model execution, usage records, pricing configuration, and limits. Frontend AI settings and usage views.
- **Approach:** Add the remaining implemented model-provider integrations behind the cycle 10 boundary. Normalize tool calls, streaming, errors, and usage without hiding provider differences. Keep provider secrets server-side and make missing configuration explicit.
- **Complete when:** Each enabled provider passes a representative tool-driven question; configuration changes take effect; successful and failed runs record usage consistently; limits prevent excess work with a clear user-facing result.

### Cycle 23 — Administration and deployment

- **Implement:** Backend `admin/`, organization provisioning, transactional invitation/signup mail, worker lifecycle, readiness, graceful shutdown, and deployment configuration. Complete required frontend public entry, legal pages, and public metadata.
- **Approach:** Keep operator access separate from product-user access. Deploy a clean environment using documented configuration and repeatable migrations. Exercise readiness checks, background workers, restart behavior, credential rotation, and recovery procedures needed for enabled features.
- **Complete when:** A fresh deployment supports onboarding and the core demo; operator endpoints reject ordinary users; a restart preserves state; deployment and recovery instructions can be followed from the repository.

### Cycle 24 — Acceptance pass and hackathon submission

- **Implement:** Any outstanding fixes revealed by cumulative acceptance, reproducible synthetic demo data, setup/run instructions, submission materials, and a backup demo recording or screenshots.
- **Approach:** Walk through every completed capability with the intended demo accounts. Run the final builds and relevant behavior checks. Rehearse a concise problem → connected data → documented meaning → grounded answer → reusable outcome narrative. Verify submission requirements and submit before the deadline.
- **Complete when:** A clean setup can reproduce the demonstration; all enabled capabilities have recorded acceptance evidence; limitations are documented; the live demo and backup are ready.

## Scope and completion rules

- Cycle 12 is the first end-to-end product checkpoint; it is not a declaration that later capabilities are complete.
- Preserve the dependency order: workspace and access before feature data; query controls before analytical tools; durable execution before scheduled or external actions; Google authorization before file access and delivery.
- Keep a feature checklist inside larger cycles, especially 20 and 23. If a cycle exceeds its timebox, split its work into reviewable commits and record the remaining tasks without silently marking it complete.
- Slack and Grokbot are catalogue placeholders in the current feature inventory. Treat actual implementations as separate future scope rather than completed integrations.
- Use synthetic demo data and explicitly label any demo-only behavior. Submission claims must match the working implementation.
- If the event deadline arrives before full coverage, present the latest verified checkpoint and document the remaining scope. The complete target remains all 24 cycles.

## Cycle record

Maintain one short entry per cycle as work happens:

| Cycle | Planned timebox | Actual time | Delivered behavior | Verification evidence | Commit | Remaining work |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | Session 1 | 2026-10-28 | Express + TypeScript backend with validated config and `/health`; React + Vite frontend showing live API health; monorepo tooling and setup docs | Clean installs; backend and frontend typecheck, build, and unit tests pass; frontend received the health response through the Vite proxy | 8c5a191, d09b96d, 2368b48 | Icon package uses the free lucide set so installs need no registry credentials |
| 02 | Session 1 | 2026-10-29 | Shared HTTP envelope, stable error codes, request ids, CORS, and Zod validation on the backend; routed app shell with layout, providers, API client, UI primitives, and error/empty/loading states on the frontend | Backend tests cover the 404 envelope, malformed JSON, and validation; frontend tests cover envelope parsing; direct URL loads verified for shell routes | 35b4ac4, e445633 | Feature pages are honest empty states until their owning cycles land |
| 03 | Session 1 | 2026-10-29 | PostgreSQL application storage with repeatable migrations, workspaces and workspace-scoped settings repositories and routes, local-only synthetic seed; frontend workspace selection, scoped requests, and a settings screen | Integration tests prove migration idempotency, cross-workspace isolation, duplicate-slug conflicts, and persistence across a fresh connection pool; without `DATABASE_URL` the API returns 503 while health stays ok; seeded demo workspace served end-to-end through the frontend proxy | 4806403, b71b38a | Authentication lands in cycle 04; workspace access is not yet tied to a signed-in user |
| 04 | Session 1 | 2026-10-30 | Users, workspace memberships with owner/admin/member roles, hashed server-side browser sessions with CSRF, identity-only Google sign-in (PKCE, single-use attempts), production-disabled dev sign-in; frontend session gate with sign-in, first-workspace onboarding, role-aware settings, sign-out, and session-expiry handling | Integration tests cover 401s, CSRF rejection, owner creation, member read-only vs owner write, non-member 404s, expired-session removal, and a fake-provider Google round-trip with replay rejection; full dev sign-in → seeded workspace → sign-out flow verified through the frontend proxy | 2338ef5, 201a6b8 | Real Google credentials still need a live check by the operator; invitations and member lifecycle arrive in cycle 21; Google file authorization stays separate (cycle 17) |
| 05 | Session 2 | 2026-10-31 | PostgreSQL sources: test → choose schemas → save → list → retest → edit → remove, with AES-256-GCM sealed passwords (`CONNECTION_ENCRYPTION_KEY`), connect/statement timeouts, small per-source pools, mapped failure reasons, and owner/admin-only management; frontend Sources pages; synthetic `shop`/`support` demo source script | Integration tests cover the full lifecycle, mapped failures, saved-password reuse rules, member 403s, non-member 404s, and secrets absent from responses and logs; live smoke through the frontend proxy covered every failure reason and a reload after a backend restart | bd0d0e4, 8be8e80 | No encryption-key rotation (a changed key means re-entering passwords); no host allowlist or rate limit on connection tests; wrong-password handling is unit-tested only because local PostgreSQL uses trust auth |
| 06 | Session 2 | 2026-10-31 | Background metadata refreshes of the selected schemas (tables, views, columns, keys, comments, view definitions) with stable ids, live progress, real cancellation, a 3-minute deadline, and one-transaction publishing; refresh on save and failed-run recovery at startup; frontend schema browser and refresh panel | Integration tests cover browsing, an added column keeping existing ids, cancel and failure leaving published metadata unchanged, roles, and history pruning; live checks covered a lock-blocked cancel, SIGTERM, and restart recovery | 8090951, b588fcc | Startup recovery assumes one backend instance; browse is capped at 2,500 objects without paging; foreign keys to unselected schemas are not recorded |
| 07 | Session 2 | 2026-10-31 | Labels, Markdown descriptions, row meaning, units, and value notes on tables and columns; foreign-key remarks and type-checked manual relationships; versioned saves whose conflicts keep the draft beside the newer version; workspace knowledge base; search across names, meaning, and entries | Integration tests cover edits surviving refreshes, needs-review relationships, stale-version 409s, type checks, knowledge permissions, and literal wildcards in search; live checks showed edits intact after reload, restart, and refresh | c78b705, 4c4f40a | No unsaved-changes guard when leaving an editor; members cannot delete their own knowledge entries (policy to confirm); search and the knowledge list use unindexed scans without paging |
| 08 | Session 2 | 2026-10-31 | MongoDB sources by fields or sealed connection string, databases in place of schemas, bounded sampling (200 documents, 16 MB) that records every type, presence, and array element types per dotted-path field, cancellation that stops the run's server operations, and per-engine read-only capability definitions; frontend engine choice and field table; synthetic MongoDB demo script | 42 integration tests (8 MongoDB) pass; a temporary auth-enabled server proved limited-privilege paths and cancel. Session 2 checkpoint: the cumulative walkthrough passed end to end through the frontend proxy for both engines, with member restrictions enforced and no secrets in any response or log | 1b18270, 79b2409 | Capabilities are enforced only from cycle 09; `mongodb+srv` strings are parsed but never resolved live; sampled fields can come and go between refreshes; the cycle 05–08 screens still need a review in a real browser |
| 09 | Session 3 | 2026-10-31 | Bounded read queries for both engines through one executor: PostgreSQL checked with PostgreSQL's own parser (one read statement, selected schemas only, a function deny list) and run in a read-only transaction with timeouts through a cursor; MongoDB `find`/`aggregate` checked against the stage allowlist at any depth; row, 5 MB, and time limits, fail-fast admission (`429 QUERY_BUSY`), cancellation that stops the work on the source, and every run recorded with a bounded result snapshot in one result format with exact numbers; frontend owner/admin query console and a reusable result table | 65 integration tests pass, covering rejection classes, truncation by rows and bytes, cancel, timeout, admission, and roles; about 85 adversarial SQL and MongoDB validator probes; live checks through the frontend proxy showed timeouts, cancels, and SIGTERM leave no busy source session and no password in any response or log | 70c82c7, 22ba5d2 | The function deny list is name-based, so a read-only source role remains the real boundary; admission, the running-query registry, and cancel are per process; SQL is parsed with the PostgreSQL 18 grammar for sources from version 12 |
| 10 | Session 3 | 2026-10-31 | Agent runtime behind a provider-neutral boundary: Anthropic provider (streamed, adaptive thinking, prompt caching, refusal fallbacks), a scripted test provider, and a labeled local demo model; a small harness with validated tool calls and step, time, and abort limits; tools for sources, metadata search, object descriptions, knowledge, `run_query` through the cycle 09 executor, and `submit_answer`, producing answers whose cited query evidence is pinned; stored conversations, runs, and ordered events; routes to start, read, and cancel runs with admission | 80 integration tests pass with scripted models; the provider was reviewed against the Claude API reference with a stubbed SDK; live demo-model answers for net revenue by month, top products, refund rate, and open tickets matched direct SQL; an unreachable source, invalid tool input, an unknown tool, and a write statement came back as recoverable tool errors | 2ae818f, 77ef872 | No live Claude call yet (no API key on this machine), so real tool-use quality and prompt wording are unverified; the backend commit subject is 74 characters, over the 72-character rule; pinned executions, conversations, and runs are never pruned |
| 11 | Session 3 | 2026-10-31 | Ask screen on the real agent: run events as Server-Sent Events with replay from `?after=` or `Last-Event-ID`, heartbeats, and live delivery; `ask_user` clarifications that pause a run until its owner answers; up to 3 text, CSV, or JSON files per question, read through `read_attachment`; frontend composer, source picker, tool progress, Markdown answers with evidence blocks (query, copy, result table, and a direct-loadable query-run page), Stop, Ask again, a reconnecting banner, and screen-reader announcements; cycle 10 review items fixed (scoped search, schema-limited descriptions, summed token usage) | 92 integration tests pass; live through the frontend proxy, streamed events equalled the stored ones, a clarification was answered after a dropped connection without duplicates, cancel worked while waiting, files were checked per type and size, and other users got 404; the frontend stream code recovered from a killed backend to a clear failed state | 046374e, 2d3c4bf | The cycle 09–11 screens still need a review in a real browser (layout, focus order, contrast, narrow widths); the event bus and clarification waits are per process |
| 12 | Session 3 | 2026-10-31 | Durable conversations and recovery: each run state change is written with its event in one statement (gap-free sequences); a restart leaves working questions `interrupted` with a `retry` disposition and **Retry** (same conversation, sources, and files), while a question waiting for a clarification resumes from a stored checkpoint; conversation list with paging, rename, delete, and earlier questions; `mutationId` so a resent question returns the run already started; 10 event streams per user; frontend conversation sidebar (a toggle on narrow screens), interrupted state with Retry, clarification deadlines, and one answer shown live and after a reload | 102 integration tests pass; live checks covered SIGTERM and kill -9 during working and waiting questions, retry, disconnect and resume, idempotent resends, and privacy for admins and non-members. Session 3 checkpoint: the cumulative walkthrough (sign-in → connect → meaning → query console → ask → evidence matching direct SQL → clarification → cancel → reload → stream drop → restart and Retry → privacy) passed end to end through the frontend proxy with the scripted demo model, with no secrets in any response or log | b455fe8, 88dcd5a | Admission, waits, the stream cap, and restart recovery assume one backend instance; a stored wait gets no timer after a restart (its deadline applies when it is answered or at the next start); `reconcile` is exercised only through SQL until tools with effects exist; the demo model answers only PostgreSQL questions, so the agent has not been exercised on MongoDB live |

At each session checkpoint, record the cumulative demo result, integration risks, and the next cycle's dependencies. Keep this record current so the final submission reflects the application that actually runs.
