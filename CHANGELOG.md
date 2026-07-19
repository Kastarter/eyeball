# Changelog

All notable source-tree changes are documented here. The npm publishing pipeline is ready, but `@eyeball` organization access and the first npm release remain pending; no hosted Cloud release is claimed.

## [0.2.0] - 2026-07-19

### Added

- A self-hosted documentation renderer with Mintlify-compatible authored MDX, persistent navigation/search/TOC shells, 112 verified pages, and compiler-generated SDK reference pages.
- Project-scoped staged files and attachment paths for Gmail, Outlook, and Google Drive, plus signed execution webhooks and replayable delivery records.
- RFC 004 trigger subscriptions with Gmail polling, Slack push ingest, deduplication, cursors, secret rotation, and signed webhook delivery.
- Optional Drizzle/Postgres persistence, exercised against embedded PGlite, for executions and idempotency, webhook records, and trigger state.
- Project request rate limits, optional UTC daily execution quotas, toolkit concurrency caps, structured redacted logs, and opt-in OpenTelemetry traces and metrics.
- A separately deployed Python voice worker implementing wire contract v1, SQLite session/event durability, stable child execution identity, fake/chat contract suites, LiveKit/WebRTC web-session assembly, and Twilio number lifecycle flows.
- Streamable HTTP/SSE MCP sessions and opt-in Tasks with execution-backed polling and identity forwarding.
- Private-cloud source for tenancy, encrypted Auth Vault and hosted connect flows, project-key lifecycle, audit, dashboard cloud mode, versioned plans, usage metering, and hybrid Stripe billing.
- Release automation for the four fixed-group public packages, a performance baseline, a product landing page, and checked-in demo media.

### Changed

- Expanded the manifest-derived contract matrix from 457 to 493 rows: 227 account-free smoke rows pass and 266 unsupported combinations are explicit.
- Corrected dashboard request binding, demo identity handling, connection display state, and Try It mutation idempotency behavior found through browser review.
- Concluded the five-piece Activepieces bridge spike in RFC 003: selective per-piece promotion only, with no wholesale vendoring or catalog-breadth claim.
- Hardened the development voice-session service identity, webhook loopback classification, and staged-upload pre-buffer limits, and aligned RFC 001–004, product, security, testing, mocks, and release documentation with the implemented boundaries.

### Validated

- Serial build, test, typecheck, lint, documentation drift/snippet/type checks, contract matrix, Python worker, package tarball, and secret-scan gates across the main, private cloud, and read-only Mockhouse repositories.
- Account-free contract coverage across all 37 default-catalog manifests and all 30 Mockhouse provider services.

### Boundaries

- This is a checked-in source version cut, not an npm publication or hosted Cloud deployment. Npm organization access, GitHub push, final license approval, production deployment, real-provider credentials/certification, and live voice/media validation remain external launch work.
- Webhook DNS rebinding protection, user-owned staged-file enforcement, session-scoped hosted voice authority, distributed trigger leases/outbox, durable process-local queues/observers, and productionization of the Activepieces bridge remain explicitly open.

## [0.1.0] - 2026-07-17

### Added

- Canonical catalog `1.1` with 37 toolkit/provider manifests and framework converters.
- Executor, TypeScript SDK, MCP gateway, Next.js admin panel, encrypted local vault, and auth CLI.
- Provider adapters plus a separate 30-provider deterministic Mockhouse repository.
- Manifest-derived 457-row contract matrix and real-provider certification seam.
- Local `dev:stack` composition and deterministic MCP and restaurant voice-agent demos.
- Public documentation source with generated toolkit references and self-hosting guides.

### Validated

- Build, test, typecheck, and lint gates across the main and mocks repositories.
- Built-mocks contract parity: 218 smoke rows pass and 239 unsupported rows are explicit.
- Mockhouse-to-executor-to-MCP composition, including Gmail execution and MCP discovery.
