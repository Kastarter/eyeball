# Eyeball

Eyeball is one typed, authenticated tool API for AI agents: agents discover canonical tools once, execute them through the SDK or MCP, and let Eyeball handle provider-specific payloads, credentials, retries, and audit records. The source tree ships a local-first stack with deterministic provider doubles, so the same execution path can be developed and tested without live SaaS accounts before it is certified against real providers.

> **Status:** `0.1.0` source preview. The local platform is runnable; the hosted cloud boundary remains in development.

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

The executor always resolves a catalog manifest and a credential before dispatching an adapter. In local development, manifest base-URL overrides point every implemented provider at Mockhouse; production deployments replace that boundary with real provider endpoints and a hosted credential vault.

## Security and trust model

Project API keys are server credentials and, by default, authorize the caller to act for every end user in that project. That is deliberate: an unpinned `key:projectId` entry is the project authority, while provider connections are still checked against both project and selected user.

When a key is handed to a less-trusted MCP host or another end-user-scoped client, pin it with `key:projectId:userId` in `EYEBALL_API_KEYS`. The executor and MCP gateway reject a different user supplied through an execute or connection body, `X-Eyeball-User-Id`, query filter, or MCP `_meta`. A gateway that uses a separate downstream executor credential must configure its inbound keyring independently; see the self-hosting guide. Keep remote traffic behind TLS, and never embed project keys in browser bundles.

The MCP gateway supports JSON and SSE Streamable HTTP responses plus opt-in experimental MCP Tasks. Stateful callers must retain the server-issued session ID; session records store only a one-way binding to the inbound credential. Browser `Origin` headers are validated before authentication.

## Repository map

The main monorepo and `mocks/` are separate Git repositories checked out together.

| Path | Purpose |
| --- | --- |
| `packages/core` | Canonical schemas, execution contracts, credentials, converters, and local vault |
| `packages/catalog` | Catalog `1.1`, 37 provider manifests, tool discovery, and auth metadata |
| `packages/toolkits` | Provider adapters for the implemented capability families |
| `packages/sdk` | TypeScript client and framework-facing helpers |
| `packages/bridge` | Compatibility boundary for external integration engines |
| `apps/executor` | Authenticated execution API, records, queues, and development connections |
| `apps/mcp-gateway` | Stateful Streamable HTTP MCP discovery, SSE, execution, and Tasks gateway |
| `apps/dashboard` | Next.js admin panel and local voice-agent testing surfaces |
| `apps/docs` | Self-hosted Next.js renderer for the authored public documentation |
| `docs/` | Product contracts, RFCs, testing policy, and certification guidance |
| `docs-site/` | Authored public MDX content and navigation source |
| `scripts/` | Documentation checks, auth CLI, and the integrated local stack |
| `mocks/` | Nested mock-provider repository: Mockhouse plus capability packages |

## Quickstart

Use Node.js 24 or newer and pnpm 11.

```sh
pnpm install
pnpm --dir mocks install
pnpm build
pnpm dev:stack
```

`dev:stack` rebuilds the nested mocks repository, then starts:

- Mockhouse with all 30 provider services at `http://127.0.0.1:4010`
- the executor at `http://127.0.0.1:3000`
- the MCP gateway at `http://127.0.0.1:3001/mcp`
- a development project using API key `eyeball_dev_project` and user `demo_user`

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

The listener ports and development identity can be changed with `EYEBALL_MOCKHOUSE_PORT`, `EYEBALL_EXECUTOR_PORT`, `EYEBALL_MCP_GATEWAY_PORT`, `EYEBALL_DEV_API_KEY`, `EYEBALL_DEV_PROJECT_ID`, and `EYEBALL_DEV_USER_ID`.

## Deployment persistence

The executor remains zero-config and process-local by default. Set `EYEBALL_DATABASE_URL` in a deployment to use the Drizzle-backed Postgres stores for executions and 24-hour idempotency, webhook endpoint and delivery logs, and trigger subscription, cursor, and dedup state. Committed migrations run at executor boot and can also be applied explicitly with `pnpm db:migrate`; `docker compose up -d postgres` starts the optional local development database. CI and contract tests use embedded PGlite and do not require Docker.

Database persistence does not yet make the closure-based execution and webhook queues, trigger polling leases, or the synchronous voice-agent definition store durable. Voice-session state and ordered events can be delegated to the separately deployed SQLite-backed worker. See [Run the executor](./docs-site/self-hosting/executor.mdx) and [Voice worker](./docs-site/self-hosting/voice-worker.mdx) for configuration and restart boundaries.

## Docs site

The repository renders `docs-site/docs.json` and all authored MDX through its own static Next.js app; no hosted documentation platform is required. Start it on the reserved documentation port with:

```sh
pnpm --filter @eyeball/docs dev
```

The site is available at `http://localhost:3003`. Use `pnpm --filter @eyeball/docs build` for a production build with all documentation routes statically generated.

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

| Surface | Status in `0.1.0` |
| --- | --- |
| Activepieces bridge breadth spike | Complete as a private experiment: five pinned pieces introspect, three actions execute in-process, and the decision is selective per-piece promotion with no wholesale vendoring; production isolation and certification remain pending ([RFC 003](./docs/rfcs/003-bridge-spike-findings.md)) |
| 37 toolkits/provider manifests | Built in catalog `1.1` with canonical schemas and discovery |
| 493-row contract matrix | Built: 227 smoke rows and 266 explicit `not_supported` rows |
| Admin panel | Built as the local Next.js dashboard |
| MCP gateway | JSON/SSE Streamable HTTP, authenticated session lifecycle, catalog/search discovery, execution metadata, and experimental task polling built; stock execution cancellation is not available |
| Documentation | Built in `docs/`, the 103-page `docs-site/` source, and the self-hosted `apps/docs` renderer |
| Local credential vault | Built with encrypted single-tenant storage and development fixtures |
| Hosted OAuth vault | Cloud work pending |
| Real-provider certification | Pending provider credentials and certification runs |
| Voice-worker control plane | Versioned Python worker, executor bridge, SQLite recovery, account-free contract suites, and Docker/Fly certification assets built; no live carrier, media, speech, or model path is certified yet |
| Billing | Cloud work pending |

## Documentation map

- [Product specification](./SPEC.md)
- [Engineering and product documentation](./docs/)
- [Authored public documentation source](./docs-site/)
- [Real-provider certification guide](./docs/CERTIFICATION.md)
- [Mock-provider repository](./mocks/README.md)
