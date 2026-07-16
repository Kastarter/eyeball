# eyeball

Open-core tool and integration platform for AI agent builders: one API supplies typed,
authenticated tools across SaaS, messaging, voice, social data, and business systems.

## Current State

- Monorepo scaffold is green; `@eyeball/core` implements RFC 001 contracts and framework converters with 79 tests.
- `@eyeball/catalog` compiles the frozen 20-capability, 187-contract, 157-provider baseline, publishes semantic email/messaging contracts plus ten provider manifests, and validates registry materialization with 32 tests.
- `@eyeball/executor` implements RFC 001 sync/async execution, polling, idempotency, API-key isolation, and adapter dispatch with 40 tests, including real-mock email and messaging flows.
- `@eyeball/toolkits` implements Gmail, Outlook, SMTP, SendGrid, Resend, and Mailgun email adapters plus Slack, Discord, Telegram, and WhatsApp Business messaging adapters; broader toolkit, SDK, MCP, and cloud implementations remain pending.
- The eight-document spec suite is:
  - `SPEC.md` — product, architecture, repos, delivery order, open questions, document map.
  - `docs/PROVIDERS.md` — definitive catalog 1.0 provider and canonical-tool inventory.
  - `docs/rfcs/001-canonical-tools.md` — normative tool/execution/error/auth contracts.
  - `docs/rfcs/002-voice-agents.md` — additive catalog 1.1 voice-agent contract.
  - `docs/MOCKS.md` — standalone mock-provider architecture and fixtures.
  - `docs/TESTING.md` — contract-heavy test, CI, and real-certification strategy.
  - `docs/ADMIN-UI.md` — hosted admin UI product and design brief.
  - `docs/DOCS-PLAN.md` — mock-first Mintlify documentation plan.

## Stack

- TypeScript, Node 24, Turborepo + pnpm, Hono, Postgres/Neon + Drizzle, Next.js.
- Core schema validation uses Ajv Draft 2020-12 plus `ajv-formats` with defaults enabled.

## Conventions

- Public package exports use ESM `.js` specifiers from package `src/index.ts` barrels.
- Credential env vars use `EYEBALL_CRED_<TOOLKIT>_*`; OSS env auth is one project/user pair.
- Executor API keys use `EYEBALL_API_KEYS="key:projectId,..."`; `/v1/*` is project-scoped and `/health` is public.
- Executor HTTP tests use Hono `app.request` and in-process provider apps; they never bind loopback sockets.
- Canonical tool names use `toolkit.operation`; restricted surfaces use reversible `toolkit__operation`.
- Format converters pass canonical JSON Schema objects through unchanged; OpenAI strict mode stays omitted until a version-pinned compatibility validator exists.
- WhatsApp Business connections keep `phoneNumberId` beside `apiKey` in the resolved API-key credential tuple; messaging calls do not repeat it under `x_provider`.
- Telegram Bot requests put the API key in the `bot{token}` path and also retain Bearer auth for the shared mock-kit triggers; Telegram ignores the extra header in production.

## Architecture

- Open-core under an FSL-1.1 placeholder; final license needs legal review.
- Auth boundary is the `CredentialProvider` seam: an OSS env provider restricted to one
  project/user pair plus deterministic mocks; private cloud vault, hosted OAuth/connect,
  refresh, and multi-user connected accounts.
- Execution storage and scheduling sit behind `ExecutionStore` and `TaskQueue`; OSS currently uses atomic in-memory idempotency plus a bounded promise queue.
- Shared adapter contracts live in `@eyeball/core`; `@eyeball/toolkits` depends on core, and the thin executor app registers toolkit adapters by slug.
- Toolkit adapters receive materialized tools, defaulted canonical input, one resolved credential, a trusted manifest base URL, fetch, clock, and logger.
- Mocks-first testing: build deterministic provider APIs and manifest-derived contracts before
  executor/toolkit implementation; unchanged suites certify real providers last.
- MCP discovery omits async-by-nature tools by default; `includeAsync` represents negotiated Tasks support and emits required/optional task support.
- Three repos: public `eyeball`, private `eyeball-cloud`, public `eyeball-mocks`.
- Catalog 1.0: 20 capabilities, 187 capability-scoped tools, 157 providers, 34 P0
  (72 P1, 51 P2). Catalog 1.1 additively introduces the P0 `voice-agents` toolkit.
- Ordinary services run on Vercel; the voice worker runs on persistent container infrastructure.

## Build Order

- The implementation dependency order is: specs complete → monorepo scaffolds → mocks → executor +
  toolkits → TypeScript SDK → MCP → admin UI → docs → real auth/certification last.
- Run the five-piece Activepieces compatibility spike as the first bridge gate.
- Keep catalog/compiler outputs, mocks, contract suites, docs reference, and runtime versions pinned.

## Known Issues

- The Outlook email mock has no message PATCH/category or move route, so mock integration can only exercise an already-applied `add_email_label`; the adapter mutation branches target real Graph routes.
- Telegram Bot `getUpdates` is an update stream, not a durable message-history API; canonical list/get coverage can only see updates still available to the bot.
- The WhatsApp Business mock GET-message route is an intentional canonical-test shim; Meta Cloud API does not support arbitrary retrieval of previously sent messages.
- `AdapterContext` has no staged-file resolver, so email and messaging adapters reject nonempty canonical attachments until executor-to-toolkit file access is specified.
- Activepieces bridge is unvalidated outside its engine; the compatibility spike is pending.
- Voice sessions need durable state and a persistent worker; Vercel Functions cannot host the media loop.
- Open contract item: reconcile RFC 001 `voiceAgentId` with RFC 002 `agentId`/revision semantics.
- Open contract item: define idempotency propagation and retry correlation for SDK,
  converter-owned execution, and MCP surfaces.
- Open contract item: specify a version-pinned LangChain converter contract or remove it from
  the launch quickstarts.
- Open contract item: define WebRTC agent-session activation, number-binding lifecycle, and
  outbound transport defaults for RFC 002.
- Open contract item: define how opaque voice-agent model references are versioned, resolved,
  credentialed, and mocked.
