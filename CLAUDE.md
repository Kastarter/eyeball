# eyeball

Open-core tool and integration platform for AI agents: one typed, authenticated API across SaaS, messaging, voice, social data, and business systems.

## Stack

- TypeScript strict mode, Node.js 24+, pnpm 11, Turborepo, Hono, Vitest, and Biome.
- Dashboard: Next.js 16, React 19, Tailwind CSS 4, and semantic CSS tokens.
- Docs renderer: Next.js 16, React 19, Tailwind CSS 4, `next-mdx-remote`, Shiki, and `remark-gfm`.
- Core schema validation: Ajv Draft 2020-12 plus `ajv-formats`.

## Conventions

- Public package exports use ESM `.js` specifiers from `src/index.ts` barrels.
- Changesets keeps `core`, `catalog`, `toolkits`, and `sdk` in one fixed version group; apps and the experimental bridge remain private.
- Canonical tools use `toolkit.operation`; restricted names use reversible `toolkit__operation`.
- `/v1/*` is API-key/project scoped; `/health` is public.
- Staged-file uploads use padded-base64 JSON; defaults are 25 MiB and one hour via `EYEBALL_FILE_MAX_BYTES` / `EYEBALL_FILE_TTL_MS`.
- Credential env vars use `EYEBALL_CRED_<TOOLKIT>_*`; `EYEBALL_API_KEYS` accepts `key:project[:user]`.
- Manifest `endpoint.baseUrlOverrideEnv` values are the only trusted provider endpoint override seam.
- HTTP and provider tests prefer Hono `app.request`; do not require loopback sockets.
- Webhooks sign `<unix-seconds>.<raw-body>` as `v1=<HMAC-SHA256 hex>`; attempts time out at 10s and retry after 0s/30s/2m/10m/1h.
- Executor logs and telemetry attributes pass through central redaction; never emit credentials, authorization headers, canonical bodies, webhook secrets, or file bytes.
- OpenTelemetry exporters are disabled unless `EYEBALL_OTEL=1`; tests use in-memory providers and never require a collector.
- Trigger events deliver as `trigger.<toolkit>.<name>` through signed webhooks; push ingest secrets appear only in create-time URLs.
- `EYEBALL_DATABASE_URL` enables the executor's five-connection Postgres pool and applies committed Drizzle migrations at boot; absent keeps all zero-config in-memory defaults.
- Executor HTTP limits share project buckets: standard 120/min with 240 burst, execute 60/min with 120 burst; `EYEBALL_RATE_LIMIT_*` overrides them and daily quota is off by default.
- The docs shell follows Mintlify-derived geometry: a 56px top bar, 576px prose column, and 256px/264px navigation rails.
- `pnpm test:contract` defaults to built mocks and writes ignored `apps/executor/contract-report.json`.
- Real certification uses `EYEBALL_CONTRACT_TARGET=real`; missing credentials are explicit skips.
- `scripts/generate-docs.ts` owns generated toolkit pages and nav; never hand-edit them.
- `scripts/generate-sdk-docs.ts` extracts the SDK export graph with the TypeScript compiler API; `docs-site/sdk/generated/` is checksum-guarded and never hand-edited.
- Public SDK client methods require TSDoc summaries, parameter guidance, normalized `@throws`, and runnable examples for primary workflows.
- After docs or catalog changes run all four `docs:*` validation commands.
- `apps/docs` reads `docs-site/docs.json` and MDX at build time; keep Mintlify-compatible component behavior in the renderer so authored pages stay unchanged.
- `/mocks/` is the read-only nested repository; `docs-site/mocks/` is tracked authored content.

## Architecture

- `@eyeball/core` owns canonical contracts, credentials, execution seams, and the local vault.
- `@eyeball/catalog` owns manifests, auth metadata, versions, and deterministic tool search.
- `@eyeball/toolkits` owns adapters; the executor resolves one manifest and credential per call.
- Execution storage and scheduling sit behind `ExecutionStore` and `TaskQueue`.
- Authenticated throttling sits behind async `RateLimiter`; manifest concurrency caps use a project/toolkit semaphore around adapter dispatch.
- Webhook endpoints/delivery logs sit behind injectable stores; delivery is async and concurrency-one per endpoint.
- Trigger subscriptions, cursors, and dedup claims sit behind injectable stores; Slack push and Gmail polling normalize against catalog schemas.
- Executor-owned Drizzle stores persist executions/idempotency, webhook endpoints/delivery attempts, and trigger subscriptions/state/dedup against pg or PGlite with the same schema and migrations.
- Staged bytes sit behind project-scoped `FileStore`; adapters resolve them only through execution-bound `AdapterContext.files`.
- The MCP gateway delegates execution to the executor and preserves child execution identities; negotiated sessions and task records sit behind async `SessionStore`.
- Project keys authorize all project users unless user-pinned; executor and MCP reject conflicting identities.
- MCP inbound key policy and its downstream executor key are separate trust boundaries.
- Conversion bundles contain native tools, an emitted dispatch map, and immutable canonical definitions.
- Public execution GET/list return `ExecutionRecord`; internal canonical input and connection context stay private.
- The auth boundary is `CredentialProvider`: local env/vault/mock implementations are OSS; hosted multi-user OAuth is cloud.
- Voice agents keep immutable revisions; child calls re-enter the normal executor under pinned scope.
- Web voice sessions compose LiveKit room/token tools and return only a short-lived end-user join grant; provider API secrets never enter session output.
- Outbound voice transport resolves deterministically: one bound number selects telephony, no binding selects only the development fake, and remote workers require configuration.
- The stock executor injects the native number-binding view into Twilio inventory/release operations so low-level calls cannot bypass detach-before-release safety.
- Mockhouse is a separate nested repository; rebuild its `dist` before contract tests.
- `docs/MOCKS.md` and `docs/TESTING.md` are authoritative for mock-versus-real parity.
- The five selected Activepieces npm pieces are self-contained bundles; framework/shared are explicit bridge compatibility pins, not peers declared by those artifacts.
- The self-hosted docs app statically generates every navigation path and builds search/TOC data from the authored MDX.

## Current State

- Source version is `0.1.0`; all nine main workspaces build, test, typecheck, and lint.
- A baseline Changeset plans the four public packages together for `0.2.0`; package manifests, tarball checks, version stamping, and manual provenance publishing are automated.
- Catalog `1.1` contains 37 manifests/toolkits and the implemented capability adapters.
- The manifest-derived matrix has 493 rows: 227 smoke and 266 explicit `not_supported`.
- The dashboard, SDK, MCP gateway, local encrypted vault, auth CLI, and public docs source are built.
- The self-hosted docs renderer builds all 111 authored/generated pages with local navigation, search, syntax highlighting, and dark/light themes.
- Search-mode MCP exposes both discovery and a generic executor-backed dispatch tool.
- MCP Streamable HTTP supports JSON and SSE POST responses, authenticated GET event streams, DELETE teardown, one-way credential-bound sessions, and opt-in 2025-11-25 Tasks with execution-backed polling and progress notifications.
- `pnpm dev:stack` boots 30-provider Mockhouse, executor, and MCP gateway with dev connections.
- Deterministic MCP and restaurant voice demos run in-process; the Anthropic episode is optional.
- The nested mocks repository has eight workspaces and 163 tests.
- The private Activepieces bridge spike imports five pinned pieces, introspects 67 actions and 23 triggers, hydrates Airtable dynamic fields, and executes Gmail, Slack, and Airtable against in-process mocks.
- Staged files flow through Gmail and Outlook send/reply/draft operations plus Google Drive upload; other email providers fail non-empty attachments explicitly as `not_supported`.
- Project-scoped signed execution webhooks and development voice-session event delivery are implemented with in-process defaults.
- Structured execution/webhook/trigger logs and pluggable traces/metrics cover the executor pipeline; OTLP export remains opt-in.
- Catalog `1.1` includes `gmail.email_received` polling and `slack.message_received` push, with executor subscription CRUD and SDK clients.
- Postgres durable stores are wired behind `EYEBALL_DATABASE_URL`; shared contracts run all stores against both memory and one embedded PGlite database.
- Project request token buckets, optional UTC daily execution quotas, and manifest-declared toolkit concurrency caps are implemented.
- A separately deployed Python voice worker provides versioned remote sessions, SQLite event durability, stable child execution identity, and account-free fake/chat contract suites; Pipecat/Twilio/LiveKit paths are certification scaffolding, not proven live-call capability.
- Voice agents expose LiveKit web-session activation plus Twilio buy/list/bind/detach/release inventory flows against account-free mocks; reassignment is detach then attach, and bound numbers cannot be released.

## Known Issues

- The Activepieces spike is not a production breadth layer: pieces need per-tool canonical mappings, isolated execution/egress, auth alignment, license provenance, and mock/real certification before catalog promotion; do not vendor the monorepo wholesale.
- Hosted OAuth vault, billing, license finalization, and real-provider certification are not complete.
- Voice-agent definitions, bindings, and executor-side session pointers remain process-local because the injectable `AgentStore` is synchronous. The remote worker durably owns session state and events, but a durable agent-store seam is still required for full executor restart recovery.
- Voice-worker parity suites prove the control-plane wire contract, deterministic recovery, and mocked provider request assembly only; Twilio, LiveKit, Deepgram, ElevenLabs, Anthropic, and end-to-end audio behavior still require live-account certification.
- Webhook endpoints and delivery attempts are durable with Postgres, but retry queues and remote voice-event observation remain process-local. Restarting the executor during an active remote session can therefore delay or omit voice webhook publication.
- Trigger records and dedup claims are durable with Postgres, while the polling scheduler still needs distributed leases, replay/backfill, provider signature verification, and an atomic claim/outbox.
- Provider idempotency propagation is separate from working executor-level replay protection.
- The stock executor remains process-local without `EYEBALL_DATABASE_URL`; Postgres makes records and 24-hour idempotency durable, but async task queues are still process-local.
- Stock rate and concurrency limiters are process-local; multi-replica global enforcement requires injected distributed implementations.
- MCP sessions and task pollers are process-local with the stock `InMemorySessionStore`; inject a durable atomic store for restart recovery. SSE event replay and stock executor cancellation are not implemented.
- The local vault serializes only within one process; do not share one file across executors.
- The local vault detects ciphertext tampering but not rollback to an older valid file; restore trusted backups and revoke upstream.
- Mocks include documented test shims where vendors lack canonical retrieval operations.
- Package publishing automation is ready, but `@eyeball` npm organization access, final license review, and the first public release remain pending; do not claim npm or hosted Cloud publication.
- Managed sandboxes may reject loopback and tsx IPC sockets with `EPERM`; use in-process apps.
