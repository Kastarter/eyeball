# eyeball

Open-core tool and integration platform for AI agent builders: one API supplies typed,
authenticated tools across SaaS, messaging, voice, social data, and business systems.

## Current State

- Specification phase complete; implementation has not started; RFCs remain review-status.
- The eight-document spec suite is:
  - `SPEC.md` — product, architecture, repos, delivery order, open questions, document map.
  - `docs/PROVIDERS.md` — definitive catalog 1.0 provider and canonical-tool inventory.
  - `docs/rfcs/001-canonical-tools.md` — normative tool/execution/error/auth contracts.
  - `docs/rfcs/002-voice-agents.md` — additive catalog 1.1 voice-agent contract.
  - `docs/MOCKS.md` — standalone mock-provider architecture and fixtures.
  - `docs/TESTING.md` — contract-heavy test, CI, and real-certification strategy.
  - `docs/ADMIN-UI.md` — hosted admin UI product and design brief.
  - `docs/DOCS-PLAN.md` — mock-first Mintlify documentation plan.

## Key Decisions

- Open-core under an FSL-1.1 placeholder; final license needs legal review.
- Auth boundary is the `CredentialProvider` seam: an OSS env provider restricted to one
  project/user pair plus deterministic mocks; private cloud vault, hosted OAuth/connect,
  refresh, and multi-user connected accounts.
- Mocks-first testing: build deterministic provider APIs and manifest-derived contracts before
  executor/toolkit implementation; unchanged suites certify real providers last.
- Three repos: public `eyeball`, private `eyeball-cloud`, public `eyeball-mocks`.
- Stack: TypeScript, Node 24, Turborepo + pnpm, Hono, Postgres/Neon + Drizzle, Next.js.
- Catalog 1.0: 20 capabilities, 187 capability-scoped tools, 157 providers, 34 P0
  (72 P1, 51 P2). Catalog 1.1 additively introduces the P0 `voice-agents` toolkit.
- Ordinary services run on Vercel; the voice worker runs on persistent container infrastructure.

## Build Order

- The implementation dependency order is: specs complete → monorepo scaffolds → mocks → executor +
  toolkits → TypeScript SDK → MCP → admin UI → docs → real auth/certification last.
- Run the five-piece Activepieces compatibility spike as the first bridge gate.
- Keep catalog/compiler outputs, mocks, contract suites, docs reference, and runtime versions pinned.

## Known Risks

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
