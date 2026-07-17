# eyeball

Open-core tool and integration platform for AI agents: one typed, authenticated API across SaaS, messaging, voice, social data, and business systems.

## Stack

- TypeScript strict mode, Node.js 24+, pnpm 11, Turborepo, Hono, Vitest, and Biome.
- Dashboard: Next.js 16, React 19, Tailwind CSS 4, and semantic CSS tokens.
- Docs renderer: Next.js 16, React 19, Tailwind CSS 4, `next-mdx-remote`, Shiki, and `remark-gfm`.
- Core schema validation: Ajv Draft 2020-12 plus `ajv-formats`.

## Conventions

- Public package exports use ESM `.js` specifiers from `src/index.ts` barrels.
- Canonical tools use `toolkit.operation`; restricted names use reversible `toolkit__operation`.
- `/v1/*` is API-key/project scoped; `/health` is public.
- Credential env vars use `EYEBALL_CRED_<TOOLKIT>_*`; `EYEBALL_API_KEYS` accepts `key:project[:user]`.
- Manifest `endpoint.baseUrlOverrideEnv` values are the only trusted provider endpoint override seam.
- HTTP and provider tests prefer Hono `app.request`; do not require loopback sockets.
- `pnpm test:contract` defaults to built mocks and writes ignored `apps/executor/contract-report.json`.
- Real certification uses `EYEBALL_CONTRACT_TARGET=real`; missing credentials are explicit skips.
- `scripts/generate-docs.ts` owns generated toolkit pages and nav; never hand-edit them.
- After docs or catalog changes run all four `docs:*` validation commands.
- `apps/docs` reads `docs-site/docs.json` and MDX at build time; keep Mintlify-compatible component behavior in the renderer so authored pages stay unchanged.
- `/mocks/` is the read-only nested repository; `docs-site/mocks/` is tracked authored content.

## Architecture

- `@eyeball/core` owns canonical contracts, credentials, execution seams, and the local vault.
- `@eyeball/catalog` owns manifests, auth metadata, versions, and deterministic tool search.
- `@eyeball/toolkits` owns adapters; the executor resolves one manifest and credential per call.
- Execution storage and scheduling sit behind `ExecutionStore` and `TaskQueue`.
- The MCP gateway delegates execution to the executor and preserves child execution identities.
- Project keys authorize all project users unless user-pinned; executor and MCP reject conflicting identities.
- MCP inbound key policy and its downstream executor key are separate trust boundaries.
- Conversion bundles contain native tools, an emitted dispatch map, and immutable canonical definitions.
- Public execution GET/list return `ExecutionRecord`; internal canonical input and connection context stay private.
- The auth boundary is `CredentialProvider`: local env/vault/mock implementations are OSS; hosted multi-user OAuth is cloud.
- Voice agents keep immutable revisions; child calls re-enter the normal executor under pinned scope.
- Mockhouse is a separate nested repository; rebuild its `dist` before contract tests.
- `docs/MOCKS.md` and `docs/TESTING.md` are authoritative for mock-versus-real parity.
- The self-hosted docs app statically generates every navigation path and builds search/TOC data from the authored MDX.

## Current State

- Source version is `0.1.0`; all eight main workspaces build, test, typecheck, and lint.
- Catalog `1.1` contains 37 manifests/toolkits and the implemented capability adapters.
- The manifest-derived matrix has 457 rows: 218 smoke and 239 explicit `not_supported`.
- The dashboard, SDK, MCP gateway, local encrypted vault, auth CLI, and public docs source are built.
- The self-hosted docs renderer builds all 100 authored pages with local navigation, search, syntax highlighting, and dark/light themes.
- Search-mode MCP exposes both discovery and a generic executor-backed dispatch tool.
- `pnpm dev:stack` boots 30-provider Mockhouse, executor, and MCP gateway with dev connections.
- Deterministic MCP and restaurant voice demos run in-process; the Anthropic episode is optional.
- The nested mocks repository has eight workspaces and 163 tests.

## Known Issues

- **Top pending:** `packages/bridge` is an empty stub; the Activepieces five-piece compatibility spike and vendoring decision are not done.
- Hosted OAuth vault, billing, license finalization, and real-provider certification are not complete.
- Voice sessions need durable state and a persistent production media worker.
- Attachments await an executor-to-adapter staged-file resolver.
- Provider idempotency propagation is separate from working executor-level replay protection.
- The stock executor uses process-local store/queue defaults; production 24-hour idempotency requires injected durable implementations.
- The local vault serializes only within one process; do not share one file across executors.
- The local vault detects ciphertext tampering but not rollback to an older valid file; restore trusted backups and revoke upstream.
- Mocks include documented test shims where vendors lack canonical retrieval operations.
- Package sources are a preview; do not claim npm or hosted Cloud publication.
- Managed sandboxes may reject loopback and tsx IPC sockets with `EPERM`; use in-process apps.
