# Eyeball

Eyeball is one typed, authenticated tool API for AI agents: agents discover canonical tools once, execute them through the SDK or MCP, and let Eyeball handle provider-specific payloads, credentials, retries, and audit records. It ships 37 toolkits across email, messaging, voice calling, CRMs, business systems, and social data — with per-end-user connected accounts as a first-class primitive and tools shaped for Anthropic, OpenAI, the Vercel AI SDK, or any MCP host.

Eyeball is **open source (MIT)**, and that is the bet: integrations are a problem solved faster by many hands than by one company. Fork it, add the toolkit your agent needs, and open a PR — every adapter hardens the layer every agent can reach. See [CONTRIBUTING.md](./CONTRIBUTING.md).

> **Status:** pre-release. The engineering is complete and gated (build, tests, typecheck, lint); when the optional maintainers' `mocks/` checkout is present, the test gates also run the 493-row contract matrix. The four public packages (`@eyeball/core`, `@eyeball/catalog`, `@eyeball/toolkits`, `@eyeball/sdk`) are cut and MIT-licensed. The npm publish is imminent, pending the `@eyeball` organization. The hosted Cloud control plane lives in a separate private repository and is not part of this open project. Provider adapters are certified against deterministic mocks in that maintainers' suite; live-provider certification is ongoing (Notion and Google Drive are proven live).

## Demo

![Eyeball demo](docs/assets/eyeball.gif)

[▶️ Watch the full-quality video](docs/assets/eyeball.mp4)

## Architecture

```text
                    +---------------------+
                    |  Agent / application|
                    +----------+----------+
                               |
                    TypeScript SDK or MCP
                               |
              +----------------+----------------+
              |                                 |
     +--------v---------+              +--------v--------+
     |   MCP gateway    |              |  Admin dashboard|
     +--------+---------+              +--------+--------+
              |                                 |
              +----------------+----------------+
                               |
                    +----------v----------+
                    |      Executor       |
                    | auth · records ·    |
                    | idempotency · queue |
                    +----+-----------+----+
                         |           |
                  catalog/tool   credential
                    adapters       provider
                         |           |
                    +----v-----------v----+
                    | Local dev vault     |
                    | + Mockhouse routes  |
                    +---------------------+
```

The executor always resolves a catalog manifest and a credential before dispatching an adapter. In the default local stack, manifest base-URL overrides point Echo, Gmail, Slack, and GitHub at the included starter Mockhouse. When the optional `mocks/` checkout is present, it supplies the full Mockhouse instead. Production deployments replace that boundary with real provider endpoints and a hosted credential vault.

## Security and trust model

Project API keys are server credentials and, by default, authorize the caller to act for every end user in that project. That is deliberate: an unpinned `key:projectId` entry is the project authority, while provider connections are still checked against both project and selected user.

When a key is handed to a less-trusted MCP host or another end-user-scoped client, pin it with `key:projectId:userId` in `EYEBALL_API_KEYS`. The executor and MCP gateway reject a different user supplied through an execute or connection body, `X-Eyeball-User-Id`, query filter, or MCP `_meta`. A gateway that uses a separate downstream executor credential must configure its inbound keyring independently; see the self-hosting guide. Keep remote traffic behind TLS, and never embed project keys in browser bundles.

The MCP gateway supports JSON and SSE Streamable HTTP responses plus opt-in experimental MCP Tasks. Stateful callers must retain the server-issued session ID; session records store only a one-way binding to the inbound credential. Browser `Origin` headers are validated before authentication.

## Repository map

The main monorepo and private `cloud/` control plane are independent Git repositories. `mocks/` is an optional, read-only checkout of the maintainers' mock repository.

| Path | Purpose |
| --- | --- |
| `packages/core` | Canonical schemas, execution contracts, credentials, converters, and local vault |
| `packages/catalog` | Catalog `1.1`, 37 provider manifests, tool discovery, and auth metadata |
| `packages/toolkits` | Provider adapters for the implemented capability families |
| `packages/sdk` | TypeScript client and framework-facing helpers |
| `packages/bridge` | Compatibility boundary for external integration engines |
| `apps/executor` | Authenticated execution API, records, queues, and development connections |
| `apps/mcp-gateway` | Stateful Streamable HTTP MCP discovery, SSE, execution, and Tasks gateway |
| `apps/dashboard` | Next.js admin panel with demo-by-default data, project webhook endpoint administration and delivery-attempt inspection, plus an explicit cloud mode for login, org/project context, hosted connections, API keys, and audit events |
| `apps/docs` | Self-hosted Next.js renderer for the authored public documentation |
| `apps/landing` | Static product landing page and interactive transcript demo |
| `apps/voice-worker` | Separately deployed Python voice-session control plane and provider-certification scaffold |
| `docs/` | Product contracts, RFCs, testing policy, and certification guidance |
| `docs-site/` | Authored public MDX content and navigation source |
| `scripts/` | Documentation checks, auth CLI, and the integrated local stack |
| `mocks/` | Optional read-only maintainers' checkout: the full 30-provider Mockhouse and 493-row certification matrix; `dev:stack` and tests use it when present |
| `cloud/` | Nested private control-plane repository: tenancy, Auth Vault/connect flows, key lifecycle, audit, and billing |

## Quickstart

Use Node.js 24 or newer and pnpm 11.

```sh
pnpm install
pnpm build
pnpm dev:stack
```

`dev:stack` starts the included starter mock stack (Echo, Gmail, Slack, and GitHub), then starts:

- the starter Mockhouse at `http://127.0.0.1:4010`
- the executor at `http://127.0.0.1:3000`
- the MCP gateway at `http://127.0.0.1:3001/mcp`
- a development project using the dev API key `eyeball_dev_project` and user `demo_user`

The SDK example below works unchanged against the starter stack.

For full provider coverage, maintainers use a separate repository checked out at `mocks/`: it contains the full 30-provider Mockhouse and the 493-row certification matrix. When that checkout is present, `pnpm dev:stack` and mock-dependent tests automatically use it; without it, `dev:stack` uses the starter stack and mock-dependent suites skip.

With the stack running, save the following SDK example as `example.ts` in the repository root:

```ts
import { Eyeball } from "@eyeball/sdk";

const eyeball = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const tools = await eyeball.tools.get({
  toolkits: ["gmail"],
  format: "anthropic",
});

const result = await eyeball.tools.run(
  "gmail.search_emails",
  { query: "from:reservations@example.com", pageSize: 5 },
  { userId: "demo_user" },
);
console.log({ modelTools: tools.tools.length, result });
```

```sh
EYEBALL_API_KEY=eyeball_dev_project \
EYEBALL_EXECUTOR_URL=http://127.0.0.1:3000 \
node --import tsx example.ts
```

### Connect from Claude Code or any MCP host

With the stack running, register the gateway as an MCP server. For Claude Code:

```sh
claude mcp add --transport http eyeball http://127.0.0.1:3001/mcp \
  --header "Authorization: Bearer eyeball_dev_project"
```

or in a `.mcp.json` / Cursor MCP configuration:

```json
{
  "mcpServers": {
    "eyeball": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer eyeball_dev_project" }
    }
  }
}
```

The gateway defaults to search discovery: agents call `eyeball.search_tools`
to find canonical tools and `eyeball.execute_tool` to run them, so hundreds of
tools never flood the model's context. Async-by-nature tools (such as
starting a phone call) run as bounded synchronous calls for ordinary MCP
hosts, or as pollable tasks for hosts that negotiate MCP Tasks.

The listener ports and development identity can be changed with `EYEBALL_MOCKHOUSE_PORT`, `EYEBALL_EXECUTOR_PORT`, `EYEBALL_MCP_GATEWAY_PORT`, `EYEBALL_DEV_API_KEY`, `EYEBALL_DEV_PROJECT_ID`, and `EYEBALL_DEV_USER_ID`.

## Live voice agents

Voice agents are first-class: compose an agent (system prompt, LLM, TTS/STT,
tool allowlist), then run it over web audio or the phone. From the dashboard's
Voice Agents panel you can create a web session and **join the room directly in
the browser** — microphone capture, live agent audio, and the running
transcript with inline tool calls. Agents with telephony tools can place real
outbound calls mid-session through `voice-agents.start_agent_call`. The full
live path — LiveKit web session, Deepgram STT, ElevenLabs TTS, Anthropic
tool-use, and a real Twilio PSTN call answered on a phone — was certified
end-to-end on 2026-07-25. See [Voice worker](./docs-site/self-hosting/voice-worker.mdx)
for deployment and the dashboard panel for the interactive flow.

## Deployment persistence

The executor remains zero-config and process-local by default. Set `EYEBALL_DATABASE_URL` in a deployment to use the Drizzle-backed Postgres stores for executions and 24-hour idempotency, lease-fenced execution and webhook jobs, immutable webhook work snapshots and delivery logs, trigger subscription/cursor/dedup state, redacted trigger-event history, staged-file metadata and content, terminal usage reports awaiting delivery, stable voice-agent heads and immutable revisions, number bindings, executor-side session pointers, lease-fenced observer cursor/phase/retry state, complete voice webhook source envelopes, and message receipts. The MCP gateway uses the same variable for its separate Postgres session/task store while keeping its own migration history. The stock FileStore uses Postgres `bytea` for content today while preserving the seam for a later object-store backend. Each owning service applies only its committed migrations at boot; root `pnpm db:migrate` applies both streams before a coordinated deployment. `docker compose up -d postgres` starts the optional local development database. CI and contract tests use embedded PGlite and do not require Docker.

With Postgres, startup recovery recreates deterministic ID-only jobs before workers begin claiming, returns expired leases to the queue, preserves webhook retry deadlines and endpoint order, and reconciles terminal webhook/usage effects. An adjacent voice-observer pass claims expired or unowned observers, resumes after the last durably handled worker sequence, and drains sessions that became terminal during downtime. Selected voice events are stored source-first and the cursor advances only after source/work admission and terminal grant handling are durable; terminal transcripts are rebuilt from the worker's complete ordered history. Staged files survive executor restart until their TTL expires, and the runtime reclaims expired rows in bounded startup and once-per-minute online batches. Redacted trigger-event history is retained for seven days with the same bounded startup and once-per-minute cleanup shape; it contains delivery metadata only and cannot reconstruct provider payloads or signed trigger webhook bodies. Voice-agent resources retain immutable historical revisions and keep bindings and pointers pinned after later updates. Gateway sessions and task records survive restart; polling resumes only when the next correctly authenticated request supplies the downstream executor credential. Without a database, all of those records, including trigger-event history, observer state, and voice webhook sources, remain process-local. A running execution is replayed only when the durable dispatch marker proves provider dispatch never began; an ambiguous post-dispatch restart fails with `execution_interrupted` instead of risking a duplicate side effect. Trigger polling leases and rate/concurrency limiters remain process-local. Voice-session state and ordered events stay authoritative in the separately deployed SQLite-backed worker. See [Run the executor](./docs-site/self-hosting/executor.mdx), [Run the MCP gateway](./docs-site/self-hosting/mcp-gateway.mdx), and [Voice worker](./docs-site/self-hosting/voice-worker.mdx) for configuration and restart boundaries.

## Docs site

The repository renders `docs-site/docs.json` and all authored MDX through its own static Next.js app; no hosted documentation platform is required. Start it on the reserved documentation port with:

```sh
pnpm --filter @eyeball/docs dev
```

The site is available at `http://localhost:3003`. Use `pnpm --filter @eyeball/docs build` for a production build with all documentation routes statically generated.

Use `pnpm docs:generate` to refresh toolkit and SDK references (`pnpm docs:sdk` refreshes only the SDK), then run `pnpm docs:check`, `pnpm docs:snippets`, and `pnpm docs:typecheck` before committing documentation changes.

## Demos

```sh
pnpm demo:mcp
pnpm demo:restaurant
ANTHROPIC_API_KEY=... pnpm demo:anthropic
```

- `demo:mcp` runs a deterministic MCP agent loop that discovers and calls Gmail, GitHub, and Slack, then verifies the provider-side effects.
- `demo:restaurant` runs the RFC 002 restaurant voice-agent flow, including a completed Pipecat session, a Calendar event, a Gmail confirmation, and a transcript artifact.
- `demo:anthropic` adds a live Anthropic tool-use loop while keeping Eyeball and its providers deterministic; it skips cleanly when `ANTHROPIC_API_KEY` is absent.

## Release status

| Surface | Status |
| --- | --- |
| Activepieces bridge breadth spike | Complete as a private experiment: five pinned pieces introspect, three actions execute in-process, and the decision is selective per-piece promotion with no wholesale vendoring; production isolation and certification remain pending ([RFC 003](./docs/rfcs/003-bridge-spike-findings.md)) |
| 37 toolkits/provider manifests | Built in catalog `1.1` with canonical schemas and discovery |
| 493-row contract matrix | Maintainers' optional `mocks/` checkout: 227 smoke rows and 266 explicit `not_supported` rows; root tests run it when that checkout is present |
| Admin panel | Built as a demo-default Next.js dashboard with in-browser voice-session join and an explicit private-cloud mode |
| MCP gateway | JSON/SSE Streamable HTTP, authenticated session lifecycle, catalog/search discovery, execution metadata, and experimental task polling built; stock execution cancellation is not available |
| Documentation | Built in `docs/`, the verified 112-page `docs-site/` source, and the self-hosted `apps/docs` renderer |
| Local credential vault | Built with encrypted single-tenant storage and development fixtures |
| Hosted OAuth vault | Implemented in the private cloud repository with encrypted credentials, hosted connect flows, and refresh scheduling; deployment and live-provider certification remain pending |
| Real-provider certification | Pending provider credentials and certification runs |
| Voice-worker control plane | Versioned Python worker, executor bridge, SQLite recovery, and account-free contract suites built; live path certified 2026-07-25 (Twilio PSTN call answered, LiveKit web session, Deepgram/ElevenLabs/Anthropic) |
| Billing | Implemented in the private cloud repository with versioned plans, usage metering, and Stripe integration; live catalog bootstrap, policy sign-off, and deployment remain pending |

## Documentation map

- [Product specification](./SPEC.md)
- [Engineering and product documentation](./docs/)
- [Authored public documentation source](./docs-site/)
- [Public package release process](./docs/RELEASING.md)
- [Real-provider certification guide](./docs/CERTIFICATION.md)
- Mockhouse and the certification matrix: separate maintainers' repository, optionally checked out at `mocks/`
