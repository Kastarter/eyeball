# eyeball — Vision

> One API that unblocks agents. Developers building AI agents get working,
> authenticated tools — email, calling, messaging, ERPs, social data, hundreds
> of SaaS apps — without building a single integration themselves.

This document is the orientation page for anyone joining the project. Read it
first, then `SPEC.md` (product/architecture spec), then `PLANNED.md` (what is
left and in what order).

## The problem

The hardest part of shipping an agent is not the model or the prompt — it is
integration. Every tool means an API to learn, an OAuth flow to build, tokens
to store and refresh, rate limits to handle, and schemas to hand-write for the
LLM. Agents act **on behalf of the developer's end-users**, so auth is
per-end-user, not per-developer — most teams get this wrong or never ship it.
And tool definitions must be re-shaped for every framework, multiplying the
work.

## What eyeball is

A **tool platform for agent builders**. Integrate eyeball once; your agents
gain a catalog of production-ready tools with managed auth, execution, and
observability.

- **SDK-first**: the customer is a developer building an agent in code. The
  TypeScript SDK is shipped; Python is a planned fast-follow.
- **Framework-native output**: the SDK hands you tools already shaped for your
  stack (Anthropic, OpenAI function calling, Vercel AI SDK, MCP). These are
  output formats — zero external framework dependencies in the codebase.
- **MCP as a second surface**: any project can be exposed as an MCP server
  (Streamable HTTP, SSE, experimental Tasks), so the same tools work inside
  Claude Code, Cursor, and other MCP hosts.
- **Tools the wrappers don't have**: first-class voice/telephony agents
  (Pipecat runtime, Twilio/LiveKit transports, immutable agent revisions,
  audited child tool-calls) and social-data adapters.
- **Smart tool selection**: deterministic BM25F search over the catalog so
  agents only see the relevant few tools per step.

## How it is built (three repositories)

| Repo | Visibility | Contents |
|---|---|---|
| `eyeball` | open-core (private until launch) | Monorepo: `@eyeball/core` (contracts, credentials, local vault), `@eyeball/catalog` (37 toolkit manifests, tool search), `@eyeball/toolkits` (adapters), executor (Hono), TypeScript SDK, MCP gateway, dashboard (Next.js), docs site (self-hosted Mintlify-grade renderer), landing page, Python voice worker |
| `eyeball-mocks` | private test infra | Mockhouse: 30 in-process provider mocks + OAuth simulator. Enables the 493-row contract matrix with zero real credentials. Nested at `eyeball/mocks/` |
| `eyeball-cloud` | private (the moat) | Hosted control plane: tenancy/orgs/projects, API-key issuance + dynamic verification, envelope-encrypted multi-tenant auth vault, hosted OAuth connect flows (PKCE, BYO apps), usage metering with transactional reservations, Stripe billing (hybrid model), lease-guarded background jobs, delinquency enforcement. Nested at `eyeball/cloud/` |

The open-core boundary is the `CredentialProvider` seam: local env/vault/mock
implementations are OSS; multi-user hosted OAuth and billing live in cloud.
The OSS executor composes against cloud purely through env-configured HTTP
seams (`EYEBALL_KEY_VERIFY_URL`, `EYEBALL_CREDENTIALS=cloud`,
`EYEBALL_USAGE_URL`) — proven end-to-end by the cross-app hosted E2E test.

## Business model (founder-decided)

Hybrid base + usage. Free: 1k executions/mo, 3 connected accounts, 1 project.
Pro $49/mo (10k executions, 25 accounts included). Scale $249/mo (100k / 250).
Overage per additional 1k executions and per connected account. Enterprise is
contact-us. Plans are versioned data in cloud, not hardcoded.

## Where the truth lives

- `SPEC.md` — product and architecture spec.
- `docs/rfcs/001–004` — canonical tools, voice agents, bridge-spike verdict,
  triggers. Contracts as tested code.
- `docs/SECURITY.md` + `cloud/SECURITY.md` — threat models and the honest
  findings registers (open items are launch gates, not surprises).
- `docs/LAUNCH-CHECKLIST.md` — what only the founder can unlock (npm org,
  license legal review, provider credentials, cloud deployment).
- `docs/CERTIFICATION.md` — mock-vs-real status per provider. Nothing claims
  live-provider certification until run with real credentials.
- `PLANNED.md` — the remaining engineering ledger, in order.
- `CLAUDE.md` (both repos) — dense working conventions and current state,
  maintained continuously; treat as authoritative for build/test workflow.

## Principles that shaped everything

1. **Contracts first**: canonical tool schemas are versioned, validated, and
   drift-checked; docs and SDK reference are generated, never hand-edited.
2. **Mock-first certification**: every tool proves behavior against Mockhouse
   in-process; real-provider runs flip one env var
   (`EYEBALL_CONTRACT_TARGET=real`).
3. **Honest boundaries**: what is not proven is documented as not proven
   (voice live-call paths, provider certification, process-local limiters).
4. **Zero-config first**: everything runs in-memory with no external services;
   `EYEBALL_DATABASE_URL` adds Postgres durability behind the same seams.
5. **Security is a register, not a vibe**: every guarantee points at its
   enforcing test; every open risk has an ID, severity, and effort estimate.
