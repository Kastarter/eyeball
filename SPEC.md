# eyeball — Product & Architecture Spec (v0.1)

> One API that unblocks agents. Developers building AI agents get working, authenticated
> tools — email, calling, messaging, ERPs, scraping, hundreds of SaaS apps — without
> building a single integration themselves.

Status: **implementation `0.1.0` complete as a local source preview** · Last updated: 2026-07-17

Implemented in `0.1.0`:

- strict canonical contracts, JSON Schema validation, lossless Anthropic/OpenAI/AI SDK/MCP conversion bundles, and catalog `1.1` discovery;
- 37 toolkit manifests, implemented native/provider adapters, and a 457-row contract matrix (218 smoke, 239 explicit `not_supported`);
- the authenticated executor, project/user-scoped connections, idempotency, async queueing, public execution records, and encrypted local vault;
- the TypeScript SDK, Streamable HTTP MCP gateway, Next.js admin dashboard, generated documentation, integrated Mockhouse stack, and deterministic MCP/restaurant demos.

This completion claim covers the repository's local `0.1.0` scope. Hosted OAuth, production durability, real-provider certification, and productionizing the experimental Activepieces bridge are not represented as complete.

---

## 1. Problem

The hardest part of shipping an agent is not the model or the prompt — it's integration:

- Every tool means an API to learn, an OAuth flow to build, tokens to store and refresh,
  rate limits and retries to handle, and schemas to hand-write for the LLM.
- Agents act **on behalf of the developer's end-users**, so auth is per-end-user, not
  per-developer — most teams get this wrong or never ship it.
- Tool definitions must be re-shaped for every framework (OpenAI Agents SDK, Anthropic,
  Vercel AI SDK, LangGraph, Pydantic AI...), multiplying the work.

## 2. What eyeball is

A **tool platform for agent builders**. You integrate eyeball once; your agents gain a
catalog of production-ready tools with managed auth, execution, and observability.

- **SDK-first** (TypeScript + Python): the primary customer is a developer building an
  agent in code — not someone configuring a no-code bot.
- **Framework-native output**: the SDK hands you tools already shaped for your stack
  (Anthropic `tools`, OpenAI function calling, Vercel AI SDK `tool()`, LangChain, MCP).
- **MCP as a secondary surface**: every project can also be exposed as a hosted MCP
  server, so the same tools work inside Claude Code, Codex, Cursor, and other MCP hosts.

### Positioning

Generalist, competing head-on with Composio / Arcade / ACI.dev / Pipedream. We win on:

1. **DX** — fewest lines from `npm install` to a working authenticated tool call.
2. **Auth done right** — end-user connected accounts as a first-class primitive.
3. **Breadth fast** — a selective Activepieces bridge can turn compatible MIT-licensed pieces
   into typed agent tools instead of hand-building every integration. The five-piece spike
   proved the seam but rejected automatic catalog-wide compatibility; promotion is per piece.
4. **Tools the wrappers don't have** — first-class calling/telephony, social-data
   scraping (ScrapeCreators), and other "real world" actions beyond SaaS CRUD.
5. **Smart tool selection** — semantic search over the catalog so agents with access to
   thousands of tools only see the relevant few per step (context-window economics).

## 3. Core concepts

| Concept | What it is |
|---|---|
| **Project** | A developer's workspace; owns API keys, connections, logs, config. |
| **Toolkit** | An app/integration (e.g. `gmail`, `slack`, `twilio`, `odoo`). Contains tools. |
| **Tool** | A single typed action, e.g. `gmail.send_email`. JSON Schema in, JSON out. |
| **Connected account** | An end-user's authorized link to a toolkit (OAuth tokens, API key), keyed by the developer's own `external_user_id`. |
| **Auth config** | Per-project OAuth app settings (use eyeball's shared OAuth apps for dev, bring-your-own for production white-labeling). |
| **Execution** | One tool call: resolved connection + validated input → runtime → logged result. |
| **Trigger** (later) | Inbound events (new email, incoming call, webhook) delivered to the agent. |

### The developer experience we're designing for

```ts
import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({ apiKey: process.env.EYEBALL_API_KEY });

// 1. Send your end-user through a hosted connect flow (once)
const { redirectUrl } = await eb.connections.create({
  userId: "user_123", toolkit: "gmail",
});

// 2. Get tools shaped for your framework, scoped to that user
const tools = await eb.tools.get({
  userId: "user_123",
  toolkits: ["gmail", "slack"],
  format: "anthropic",           // or "openai" | "ai-sdk" | "langchain" | "mcp"
});

// 3. Hand them to your agent loop — execution routes through eyeball
const result = await eb.tools.execute("gmail.send_email", {
  userId: "user_123",
  input: { to: ["a@b.com"], subject: "hi", body: "..." },
  // Mutations also send RFC 001's Idempotency-Key; surface mapping is open in §9.
});
```

## 4. Architecture

Two planes, one catalog:

```
┌────────────────────────────────────────────────────────────┐
│ CONTROL PLANE                                              │
│  Dashboard (Next.js) · REST API · API keys · Auth configs  │
│  Connect flows (hosted OAuth) · Logs & usage UI            │
├────────────────────────────────────────────────────────────┤
│ TOOL CATALOG                                               │
│  Registry: tool schemas, metadata, embeddings for search   │
│  Sources:                                                  │
│   • Activepieces bridge (piece action → typed tool)        │
│   • Native tools (calling and custom-built runtimes)       │
│   • ScrapeCreators adapters (public social data)           │
│   • Developer-defined custom tools (later)                 │
├────────────────────────────────────────────────────────────┤
│ EXECUTION PLANE                                            │
│  Executor service: validate input → resolve connection →   │
│  inject auth → run → normalize errors → log                │
│  Experimental piece runner (five-piece spike only)          │
│  Long-running jobs (calls, big scrapes) via queue + poll   │
├────────────────────────────────────────────────────────────┤
│ AUTH VAULT                                                 │
│  Encrypted token store (per connected account)             │
│  OAuth dance handling · automatic refresh · scope tracking │
└────────────────────────────────────────────────────────────┘
Postgres (catalog, projects, connections, executions) · Redis (queue, rate limits)
```

### Key design decisions

- **The Activepieces bridge is an experimental selective breadth seam.** The five-piece spike
  in `packages/bridge` imports Gmail, Airtable, Slack, Discord, and Typeform; introspects real
  actions, triggers, props, and auth; transforms strict JSON Schema; hydrates one real dynamic
  schema; and executes Gmail, Slack, and Airtable against existing in-process mocks. It also
  proved that dynamic props need connection-time resolution, bundled clients do not share one
  transport seam, and engine context/auth assumptions vary by piece. The decision is no
  wholesale vendoring and no "one bridge, ~280 toolkits" claim: promote exact pinned pieces
  individually behind an isolated worker and per-piece certification. See RFC 003.
- **Non-bridge tools where wrappers fall short.** Native calling/telephony (place a call,
  agent speaks/listens — long-running, stateful) and ScrapeCreators-backed social-data
  adapters (profiles, posts, creator search) are separate catalog sources. Browser-ish
  actions come later. These cannot be expressed as simple request/response pieces.
- **Execution is synchronous by default, async when needed.** Simple tools return
  inline. Long-running tools (a phone call) return an execution id + status polling /
  webhook, and the SDK exposes both modes.
- **Tool search is part of the API.** `eb.tools.search({ query, userId })` returns the
  top-k relevant tools with schemas — designed to be called *by the agent* mid-loop
  (and exposed through MCP as a search tool), so context stays small.
- **MCP gateway is a thin adapter** over the same catalog + executor: one hosted MCP URL
  per project (optionally per end-user) with the project's enabled toolkits.
- **Mock mode selects an executor, not a provider URL.** The SDK constructor can target a
  dedicated project-scoped mock executor whose server process owns manifest base-URL overrides
  and `MockCredentialProvider`. The flag never enters `ExecuteRequest` and cannot redirect an
  adapter inside a production executor.

### Data model sketch

```
projects(id, name, owner, ...)
api_keys(id, project_id, hash, scopes)
toolkits(slug, name, source: 'activepieces-bridge'|'native'|'scrapecreators', auth_type, ...)
tools(id, toolkit_slug, name, json_schema, description, embedding)
auth_configs(id, project_id, toolkit_slug, oauth_client..., is_shared)
connected_accounts(id, project_id, external_user_id, toolkit_slug,
                   credentials_encrypted, status, expires_at)
executions(id, project_id, tool_id, connected_account_id, input, output,
           status, latency_ms, error, created_at)
```

## 5. Competitive notes

| Player | Their strength | Our counter |
|---|---|---|
| Composio | Huge catalog, mindshare | DX + pricing + native calling/scraping; they're heavy and enterprise-tilted |
| Arcade.dev | Auth story, MCP focus | SDK-first breadth; they're thinner on catalog |
| ACI.dev | Open source | Better hosted DX; consider open-core ourselves (open question) |
| Pipedream | Mature infra, many apps | Agent-native design; theirs is workflow-first |
| Raw MCP servers | Free, everywhere | We solve multi-user auth, hosting, observability — the parts MCP leaves out |

## 6. Delivery status

- **Specification baseline (complete).** The nine-document suite fixes catalog 1.0
  (20 capabilities, 187 capability-scoped tools, 157 providers, 34 P0), RFC 001 contracts,
  additive catalog 1.1 voice agents, mock architecture, testing, admin UI, and public docs.
- **Local `0.1.0` implementation (complete).** Core, catalog, adapters, executor, TypeScript
  SDK, MCP gateway, dashboard, docs, local vault, Mockhouse integration, and deterministic
  demos build and pass the repository gates.
- **Activepieces breadth bridge (experimental spike complete).** The five-piece result supports
  selective per-piece promotion only. Isolated execution, transport profiles, auth alignment,
  license provenance, and mock/real certification remain before any breadth claim.
- **Hosted/live work (later).** Hosted auth/connect flows, production durability, Python/P1/P2
  breadth, and real-provider certification follow the proven local core loop.

## 7. Decisions made (2026-07-16)

- **Open-core.** Public repo under a fair-source license (FSL-1.1 as placeholder;
  intent: commercial users must attribute/disclose they build on eyeball; legal pass
  before launch, not now).
- **Auth is the closed moat.** The open/closed line is the `CredentialProvider`
  interface: OSS ships a toy provider (env vars / static keys restricted to one project/user
  pair); production multi-user
  auth (hosted OAuth, connect UI, refresh, connected accounts) exists only as the
  eyeball cloud provider. Self-hosted executors phone home to the Auth Vault API.
- **Security/compliance posture deferred to last** — with one exception: credentials
  encrypted at rest from day one (retrofitting means migrating live tokens).
- **Infra: Vercel for the control plane and ordinary executor.** Fluid Compute (300s)
  covers request/response tools; long-running tools are async-by-design (execution id +
  poll/webhook). The catalog 1.1 voice runtime adds a separately deployed persistent worker.

## 8. Build plan

### Repo strategy

- **`eyeball` (public):** `packages/core` (tool types, schemas, format converters),
  `packages/sdk` (TS), `packages/bridge` (Activepieces transformer + runner shim),
  `apps/executor`, `apps/voice-worker`, `apps/mcp-gateway`, `docs/`.
- **`eyeball-cloud` (private):** auth vault + OAuth flows + hosted connect UI,
  control-plane API (projects, keys, connections), dashboard, billing.
- **`eyeball-mocks` (public):** deterministic provider-facing APIs, fixture bundles,
  simulated clock, scripted voice callers, and reusable mock/real contract harnesses.

### Stack

TypeScript end to end, Node 24. Postgres (Neon) + Drizzle. Hono for the API.
Next.js dashboard. Turborepo + pnpm. The control plane, dashboard, and ordinary executor
deploy to Vercel; the voice worker requires persistent container infrastructure.

### Order of work

The original dependency order and current result are:

1. **Specifications (complete)** — the nine-document suite and frozen contract hierarchy.
2. **Repository scaffolds (complete)** — initialize the main and nested mock monorepos.
3. **Mocks and contracts (complete for local `0.1.0`)** — Mockhouse, fixtures, scripted
   voice behavior, and manifest-derived suites.
4. **Executor and toolkits (complete for implemented native/provider adapters)** — core
   validators/catalog compiler, credential seam, execution records, adapters, and local voice
   demo. The private five-piece Activepieces compatibility spike is complete; production
   integration is deliberately gated by RFC 003.
5. **TypeScript SDK (complete)** — discovery, lossless conversion bundles, execution, polling,
   and model tool-call helpers.
6. **MCP gateway and tool search (complete)** — catalog/search discovery and executor-backed
   calls, including the generic search-mode dispatch tool.
7. **Admin UI (complete for local operations)** — toolkit, connection, voice, and public
   execution-record surfaces.
8. **Public docs (complete as source-preview docs)** — mock-first quickstarts, generated
   toolkit reference, and voice showcase.
9. **Real auth and certification (pending)** — cloud `CredentialProvider`, hosted connect flows,
   then unchanged contract suites against dedicated vendor tenants.

Deliberately deferred: triggers/inbound events, BYO OAuth apps, billing, dashboard
polish, security/compliance program.

## 9. Remaining open questions

1. **Activepieces bridge productionization.** The spike decision is to track exact upstream
   packages during evaluation, never vendor the monorepo wholesale, and take a minimal audited
   snapshot/fork only for a promoted piece that needs patches. The remaining open work is the
   isolated runner, per-piece canonical/auth/transport profiles, license provenance, and
   mock/real certification described by RFC 003.
2. **Billing model.** Per-execution vs per-connected-account; free-tier shape drives adoption
   for a DX-led product.
3. **License finalization.** FSL-1.1 vs Elastic 2.0 vs a custom attribution clause needs a
   legal pass before public launch.

## 10. Document map

Conflict order is RFC 001 > provider catalog > RFC 002 > mocks > testing > product/UI/docs.
RFC 003 is a subordinate experimental finding and does not redefine those contracts.
Each document is authoritative only for the role named here:

| Document | Authority and role |
|---|---|
| `docs/rfcs/001-canonical-tools.md` | Highest authority for tool, execution, error, credential, conversion, and versioning contracts. |
| `docs/PROVIDERS.md` | Definitive catalog 1.0 authority for capabilities, canonical names, toolkit slugs, tiers, membership, and counts. |
| `docs/rfcs/002-voice-agents.md` | Additive catalog 1.1 authority for immutable voice-agent resources, tools, sessions, and persistent-worker semantics; subordinate to RFC 001. |
| `docs/rfcs/003-bridge-spike-findings.md` | Experimental evidence and promotion decision for the Activepieces bridge; non-normative where RFC 001 or the provider catalog is more specific. |
| `docs/MOCKS.md` | Authority for mock architecture, control endpoints, fixture tokens, fidelity, P0 inventory, and real-auth swap behavior. |
| `docs/TESTING.md` | Test-pyramid, contract-suite, CI, and certification strategy; it references rather than redefines higher contracts. |
| `SPEC.md` | Product intent, architecture context, repository strategy, delivery order, and open decisions; non-normative where an RFC or catalog is more specific. |
| `docs/ADMIN-UI.md` | Non-normative hosted-control-plane UX and visual direction. |
| `docs/DOCS-PLAN.md` | Non-normative public documentation IA, examples, and manifest-generated reference plan. |
