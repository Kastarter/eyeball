# eyeball

Open-core tool and integration platform for AI agents: one typed, authenticated API across SaaS, messaging, voice, social data, and business systems.

## Stack

- TypeScript strict mode, Node.js 24+, pnpm 11, Turborepo, Hono, Vitest, and Biome.
- Dashboard: Next.js 16, React 19, Tailwind CSS 4, and semantic CSS tokens.
- Docs renderer: Next.js 16, React 19, Tailwind CSS 4, `next-mdx-remote`, Shiki, and `remark-gfm`.
- Core schema validation: Ajv Draft 2020-12 plus `ajv-formats`.

## Conventions

- Public package exports use ESM `.js` specifiers from `src/index.ts` barrels.
- Release and docs copy must distinguish checked-in private Cloud source from a deployed hosted service and must not imply npm or live-provider certification.
- Changesets keeps `core`, `catalog`, `toolkits`, and `sdk` in one fixed version group; every Node app and the experimental bridge are explicitly ignored and remain private.
- Canonical tools use `toolkit.operation`; restricted names use reversible `toolkit__operation`.
- `/v1/*` is API-key/project scoped; `/health` is public.
- Staged-file uploads use padded-base64 JSON; defaults are 25 MiB and one hour via `EYEBALL_FILE_MAX_BYTES` / `EYEBALL_FILE_TTL_MS`, with a pre-buffer body ceiling for encoded content plus 16 KiB metadata overhead.
- Credential env vars use `EYEBALL_CRED_<TOOLKIT>_*`; `EYEBALL_API_KEYS` accepts `key:project[:user]`.
- Manifest `endpoint.baseUrlOverrideEnv` values are the only trusted provider endpoint override seam.
- HTTP and provider tests prefer Hono `app.request`; do not require loopback sockets.
- Real Cloud integration tests load the ignored sibling checkout conditionally so OSS-only clones keep passing.
- Webhooks sign `<unix-seconds>.<raw-body>` as `v1=<HMAC-SHA256 hex>`; attempts time out at 10s and retry after 0s/30s/2m/10m/1h.
- Webhook URL validation strips trailing DNS root dots before rejecting localhost, `.localhost`, `.local`, and literal private-network targets; delivery never follows redirects.
- Executor logs and telemetry attributes pass through central redaction; never emit credentials, authorization headers, canonical bodies, webhook secrets, or file bytes.
- OpenTelemetry exporters are disabled unless `EYEBALL_OTEL=1`; tests use in-memory providers and never require a collector.
- Trigger events deliver as `trigger.<toolkit>.<name>` through signed webhooks; push ingest secrets appear only in create-time URLs.
- Unauthenticated push-trigger ingest is capped at 1 MiB before buffering; exposed path credentials rotate through the subscription rotation endpoint.
- `EYEBALL_DATABASE_URL` enables the executor's five-connection Postgres pool, including durable staged-file metadata/content and durable voice-agent resources, and applies committed executor Drizzle migrations at boot; absent keeps all zero-config in-memory defaults.
- Executor HTTP limits share project buckets: standard 120/min with 240 burst, execute 60/min with 120 burst; `EYEBALL_RATE_LIMIT_*` overrides them and daily quota is off by default.
- Cloud execution usage reserves after project throttling and before record allocation; execution stores preflight idempotent replays, and terminal reports reuse one opaque SHA-256 identity.
- Usage reservations release on failures before adapter dispatch; attempted adapter calls report through the terminal outbox.
- The docs shell follows Mintlify-derived geometry: a 56px top bar, 576px prose column, and 256px/264px navigation rails.
- Dashboard cloud mode is explicit: `NEXT_PUBLIC_EYEBALL_MODE=cloud` selects cloud-backed features and server-only `EYEBALL_CLOUD_URL` supplies the control-plane origin; unset remains demo mode.
- Dashboard cloud requests use the same-origin `/api/cloud` allowlist proxy; org/project context and manually pasted per-project executor keys live in validated `HttpOnly` cookies.
- Cloud Stripe returns land on session-gated `/billing/checkout/success` and `/billing/checkout/cancel`; `/billing?org=...` renders organization billing, current-month usage, plan comparison, checkout, and portal controls.
- Cloud API-key verification is authenticated `POST /internal/keys/verify` with a pre-buffer 4 KiB body cap and a 1,024-character key schema; never place customer keys in internal URL queries.
- Hosted executor auth checks static `EYEBALL_API_KEYS` before Cloud verification; remote caches use SHA-256 key digests with 60s positive/5s negative defaults, and `EYEBALL_CREDENTIALS=cloud` uses the executor-owned HTTP credential client.
- Authenticated dashboard, provider, webhook, and remote-voice HTTP clients use manual redirect handling; remote voice requires HTTPS outside explicit loopback and supplied control tokens are at least 32 characters.
- `pnpm check:secrets` scans tracked files without printing candidate values and runs from root lint; production CI should add gitleaks.
- Dashboard cloud proxying uses an explicit method-and-path allowlist within `/v1`; executor proxying retains `/health` and `/v1/*` behavior for its ordinary existing methods but permits `PATCH` only for `/v1/webhooks/:endpointId`, and both proxies construct upstream URLs from allowlisted inputs.
- Executor telemetry and cloud audit redaction treat named URL fields as secret-bearing because path/query credentials remain in supported callback protocols.
- `pnpm test:contract` defaults to built mocks and writes ignored `apps/executor/contract-report.json`.
- The tracked-file secret scanner skips index entries deleted by an in-progress release/version change; it must still scan every existing tracked text file.
- `pnpm bench` runs the executor/Mockhouse in-process baseline: 200 warmups, 2,000 measured requests, max 32 in flight, GC/vm_stat sampling, and a 1,500 MiB RSS abort ceiling.
- Real certification uses `EYEBALL_CONTRACT_TARGET=real`; missing credentials are explicit skips.
- `docs/CERTIFICATION.md` tracks every shipped manifest; planned catalog entries stay visibly marked `not shipped`.
- `scripts/generate-docs.ts` owns generated toolkit pages and nav; never hand-edit them.
- `scripts/generate-sdk-docs.ts` extracts the SDK export graph with the TypeScript compiler API; `docs-site/sdk/generated/` is checksum-guarded and never hand-edited.
- Public SDK client methods require TSDoc summaries, parameter guidance, normalized `@throws`, and runnable examples for primary workflows.
- After docs or catalog changes run all four `docs:*` validation commands; `docs:check` dry-runs both generators before structural validation.
- `apps/docs` reads `docs-site/docs.json` and MDX at build time; keep Mintlify-compatible component behavior in the renderer so authored pages stay unchanged.
- `/mocks/` is the read-only nested repository; `docs-site/mocks/` is tracked authored content.

## Architecture

- `@eyeball/core` owns canonical contracts, credentials, execution seams, and the local vault.
- `@eyeball/catalog` owns manifests, auth metadata, versions, and deterministic tool search.
- `@eyeball/toolkits` owns adapters; the executor resolves one manifest and credential per call.
- Execution storage and serializable job scheduling sit behind `ExecutionStore` and `TaskQueue`; the Postgres composition uses leased jobs while zero-config remains in memory.
- Authenticated throttling sits behind async `RateLimiter`; manifest concurrency caps use a project/toolkit semaphore around adapter dispatch.
- `UsageGate` defaults to no-op; the Cloud implementation reserves synchronously and reports terminal records through an at-least-once outbox.
- Webhook endpoints, delivery logs, and ID-only event work sit behind injectable stores; handlers re-resolve current endpoints and source records, while delivery is async and concurrency-one per endpoint.
- Trigger subscriptions, cursors, and dedup claims sit behind injectable stores; Slack push and Gmail polling normalize against catalog schemas.
- Executor-owned Drizzle stores persist executions/idempotency, leased task jobs, ID-only webhook event work, webhook endpoints/delivery attempts, trigger subscriptions/state/dedup, staged-file metadata/content, stable voice-agent heads, immutable agent revisions, number bindings, executor-side session pointers, and message receipts against pg or PGlite with the same schema and migrations.
- Staged files sit behind project-scoped `FileStore`; the stock Postgres implementation stores bytes in `bytea`, while the seam permits a later metadata-plus-object-store implementation without changing routes, the engine, or adapters. Adapters resolve bytes only through execution-bound `AdapterContext.files`.
- The MCP gateway delegates execution to the executor and preserves child execution identities; negotiated sessions and task records sit behind async `SessionStore`, with in-memory injection by default and a stock Postgres implementation using an independent gateway migration history.
- Project keys authorize all project users unless user-pinned; executor and MCP reject conflicting identities.
- MCP inbound key policy and its downstream executor key are separate trust boundaries.
- Conversion bundles contain native tools, an emitted dispatch map, and immutable canonical definitions.
- Public execution GET/list return `ExecutionRecord`; internal canonical input and connection context stay private.
- The auth boundary is `CredentialProvider`: local env/vault/mock implementations and the hosted HTTP client are OSS; multi-user credential ownership and refresh policy remain in Cloud.
- Voice agents keep immutable revisions; child calls re-enter the normal executor under pinned scope.
- Dev-stack voice sessions use a deployment-scoped Pipecat service identity and share one agent store with the request-driven session driver; voice-agent management auth remains `none`.
- Web voice sessions compose LiveKit room/token tools and return only a short-lived end-user join grant; provider API secrets never enter session output.
- Outbound voice transport resolves deterministically: one bound number selects telephony, no binding selects only the development fake, and remote workers require configuration.
- The stock executor injects the native number-binding view into Twilio inventory/release operations so low-level calls cannot bypass detach-before-release safety.
- Mockhouse is a separate nested repository; rebuild its `dist` before contract tests.
- `docs/MOCKS.md` and `docs/TESTING.md` are authoritative for mock-versus-real parity.
- The five selected Activepieces npm pieces are self-contained bundles; framework/shared are explicit bridge compatibility pins, not peers declared by those artifacts.
- The self-hosted docs app statically generates every navigation path and builds search/TOC data from the authored MDX.
- Catalog registries memoize deep-frozen materialized tool/trigger lookups; schema validators skip repeated fingerprints only for recursively frozen schemas, preserving mutation checks for mutable inputs.
- The dashboard uses one feature-level mode seam: auth, orgs/projects, connections, API keys, and audit switch to the cloud control plane while toolkits, executions, webhooks, triggers, and voice agents retain the executor/catalog data paths.

## Current State

- Source version is `0.2.0`; the root and four fixed-group public package manifests have been cut locally, while npm and hosted publication remain unclaimed.
- Package changelogs, tarball checks, version stamping, and protected manual provenance publishing are automated; the baseline `0.2.0` Changeset has been consumed.
- The final 0.2.0 review passes fresh serial build, test, typecheck, lint, docs, 493-row contract, ten-test Python worker, cloud, Mockhouse, tarball, and tracked-file secret gates.
- Hosted release-gate scenarios 1–5 are automated in one conditional in-process Cloud/executor suite covering provisioning, vault refresh, exact-once usage, last-slot admission, bounded key revocation, and executor log-secret absence.
- Catalog `1.1` contains 37 manifests/toolkits and the implemented capability adapters.
- The manifest-derived matrix has 493 rows: 227 smoke and 266 explicit `not_supported`.
- The dashboard, SDK, MCP gateway, local encrypted vault, auth CLI, and public docs source are built.
- The self-hosted docs renderer builds all 113 authored/generated pages with local navigation, search, syntax highlighting, and dark/light themes.
- The dashboard has demo-default and cloud modes; cloud mode adds session auth, first-run org/project/key bootstrap, real connection/key/audit screens, project switchers, and per-project executor-key settings.
- The project Webhooks surface provides endpoint CRUD, catalog-derived exact trigger selection, reveal-once create/rotation secrets, confirmed rotation/deletion, and metadata-only paginated delivery attempts through the executor in both dashboard modes; the proxy exports scoped endpoint-update `PATCH` coverage without broadening unrelated routes.
- The project Triggers surface provides subscription create/manage/delete with catalog-derived trigger and delivery-mode selection, minimum-validated polling cadence, webhook endpoint targeting, reveal-once create/rotation push ingest URLs, and confirmed destructive actions through the executor in both dashboard modes; subscription projections never retain ingest URLs.
- Cloud mode has full Billing and Organization surfaces for usage, plan changes, members, BYO OAuth apps, redirect origins, organization rename, and audit navigation; OAuth connection setup can select an app and validated return URL, and the dashboard suite has 101 serial tests.
- Search-mode MCP exposes both discovery and a generic executor-backed dispatch tool.
- MCP Streamable HTTP supports JSON and SSE POST responses, authenticated GET event streams, DELETE teardown, one-way credential-and-scope-bound sessions, and opt-in 2025-11-25 Tasks with execution-backed polling and progress notifications.
- `pnpm dev:stack` boots 30-provider Mockhouse, executor, and MCP gateway with dev connections.
- Deterministic MCP and restaurant voice demos run in-process; the Anthropic episode is optional.
- The nested mocks repository has eight workspaces and 164 tests.
- The private Activepieces bridge spike imports five pinned pieces, introspects 67 actions and 23 triggers, hydrates Airtable dynamic fields, and executes Gmail, Slack, and Airtable against in-process mocks.
- Staged files flow through Gmail and Outlook send/reply/draft operations plus Google Drive upload; other email providers fail non-empty attachments explicitly as `not_supported`.
- `GET /v1/files` provides newest-first cursor pagination over unexpired project metadata to unpinned project-authority keys, and `eyeball.files.list` exposes the same contract in the SDK.
- Project-scoped signed execution and voice webhooks are implemented with in-process defaults; Postgres adds durable source-first remote voice event/transcript/failure publication and startup reconciliation.
- Structured execution/webhook/trigger logs and pluggable traces/metrics cover the executor pipeline; OTLP export remains opt-in.
- Catalog `1.1` includes `gmail.email_received` polling and `slack.message_received` push, with executor subscription CRUD and SDK clients.
- Postgres durable stores are wired behind `EYEBALL_DATABASE_URL`; the leased async queue and boot recovery sweep resume pending/running executions plus webhook selection/delivery jobs, staged files survive executor restarts until TTL expiry, and voice-agent definitions, immutable revisions, bindings, session pointers, observer cursor/phase/retry state, voice webhook source envelopes, and receipts are durable and read on demand. A non-overlapping minute sweep reclaims expired files in 100-row online batches, while shared contracts run all stores against both memory and embedded PGlite.
- The MCP gateway separately migrates and selects its Postgres `SessionStore` when `EYEBALL_DATABASE_URL` is configured. Negotiated sessions and task records survive restart; polling resumes on the next correctly authenticated request rather than through durable poll timers.
- Project request token buckets, optional UTC daily execution quotas, and manifest-declared toolkit concurrency caps are implemented.
- `EYEBALL_USAGE_URL` enables Cloud quota admission and terminal billing reports; unset `EYEBALL_USAGE_STRICT` defaults strict with `EYEBALL_CREDENTIALS=cloud` and fail open otherwise, while explicit `1`/`true` or `0`/`false` overrides either composition.
- A separately deployed Python voice worker provides versioned remote sessions, SQLite event durability, stable child execution identity, per-session executor capabilities, and account-free fake/chat contract suites; Pipecat/Twilio/LiveKit paths are certification scaffolding, not proven live-call capability.
- Voice agents expose LiveKit web-session activation plus Twilio buy/list/bind/detach/release inventory flows against account-free mocks; reassignment is detach then attach, and bound numbers cannot be released.
- The security posture pass added product/cloud threat models, an incident-response runbook, SHA-pinned CI actions, trigger-secret rotation, and query/log/redirect hardening.
- The 2026-07-19 Apple M4 in-process executor baseline is 0.247 ms p95 and 4,922 req/s for sync Gmail execution; adapter dispatch is the largest named traced stage.
- The stock executor composes Cloud-issued key verification and hosted credential resolution independently through bearer-authenticated, no-store, in-process-testable HTTP seams.

## Known Issues

- The read-only nested `mocks/README.md` still reports 163 tests; the current suite is expected to report 164 after the Twilio number-inventory addition and must be corrected in that repository by its owner.
- The Activepieces spike is not a production breadth layer: pieces need per-tool canonical mappings, isolated execution/egress, auth alignment, license provenance, and mock/real certification before catalog promotion; do not vendor the monorepo wholesale.
- Hosted OAuth and billing are implemented in private cloud source, but cloud deployment/KMS/backup operations, live Stripe/provider validation, license finalization, and real-provider certification are not complete.
- Cloud dashboard executor keys are not auto-provisioned into UI sessions; an operator must copy a reveal-once project key into each selected project's Settings screen.
- With `EYEBALL_DATABASE_URL`, Postgres persists voice-agent definitions, immutable revisions, bindings, executor-side session pointers, observer cursor/phase/retry state, complete voice webhook source envelopes, and message receipts. The remote worker remains authoritative for live session state and its gap-free ordered event stream. The observer cursor advances only after selected webhook source/admission and terminal handling are durable.
- Voice-worker parity suites prove the control-plane wire contract, deterministic recovery, and mocked provider request assembly only; Twilio, LiveKit, Deepgram, ElevenLabs, Anthropic, and end-to-end audio behavior still require live-account certification.
- The v2 voice-worker contract supports short-lived executor capabilities scoped to one audience, project, user, session, expiry, and immutable tool allowlist. If `EYEBALL_VOICE_SESSION_GRANT_SECRET` is unset, the static `EYEBALL_VOICE_WORKER_KEY` fallback still requires one worker per trusted pinned user.
- Startup claims expired or unowned voice observers, resumes after the durable cursor, drains sessions that became terminal while the executor was down, revokes grants idempotently, and reconstructs terminal transcripts from complete worker history. Voice webhook bodies are no longer process-local when Postgres is configured; execution envelopes reconstruct from durable executions, while trigger bodies still lack a durable source record.
- Observer leases and shared voice sources are designed for safe ownership and reconstruction, but managed multi-replica load/chaos certification, production backup/restore drills, and live-provider certification remain open.
- Trigger records and dedup claims are durable with Postgres, while the polling scheduler still needs distributed leases, replay/backfill, provider signature verification, and an atomic claim/outbox.
- Provider idempotency propagation is separate from working executor-level replay protection.
- The stock executor remains process-local without `EYEBALL_DATABASE_URL`, including staged uploads, voice-agent definitions/revisions, number bindings, session pointers, observer state, voice webhook sources, and message receipts. Postgres makes records, 24-hour idempotency, leased async task jobs, staged-file metadata/bytes, and voice-agent/observer state durable; staged files survive restart only until `expiresAt`, and boot recovery plus observer reconciliation run before workers claim jobs.
- The usage outbox is restart-durable with Postgres; without it, pending reports and the single-process flusher remain process-local.
- Stock rate and concurrency limiters are process-local; multi-replica global enforcement requires injected distributed implementations.
- MCP sessions and task records are durable with the stock Postgres `SessionStore` when `EYEBALL_DATABASE_URL` is configured and process-local with the zero-database `InMemorySessionStore`. After restart, polling is rearmed by the next correctly authenticated request; timer handles and SSE subscribers remain process-local, and SSE replay plus stock executor cancellation are not implemented.
- The local vault serializes only within one process; do not share one file across executors.
- The local vault detects ciphertext tampering but not rollback to an older valid file; restore trusted backups and revoke upstream.
- Mocks include documented test shims where vendors lack canonical retrieval operations.
- Package publishing automation is ready, but `@eyeball` npm organization access, final license review, and the first public release remain pending; do not claim npm or hosted Cloud publication.
- Webhook delivery blocks literal private targets and redirects but does not resolve/pin DNS, so DNS-rebinding SSRF remains a hosted-launch gate.
- The Activepieces spike contains unpatched `expr-eval` High advisories and incomplete published license metadata; do not expose its formula evaluator to untrusted input or promote it before replacement/provenance work.
- Internal cloud bearer requests remain replayable without timestamp/nonce signing; trigger and voice URL secrets require upstream access-log suppression, and push triggers still need provider-native signature verification.
- Staged files are project-scoped bearer capabilities rather than user-owned records; pinned keys cannot enumerate `GET /v1/files`, but until ownership is added, a leaked or learned same-project file ID can cross a user-pinned boundary during its TTL.
- Voice Python dependencies are direct-pinned but not transitively hash-locked or covered by `pip-audit`; cloud billing grace still permits existing execution indefinitely.
- Managed sandboxes may reject loopback and tsx IPC sockets with `EPERM`; use in-process apps.
