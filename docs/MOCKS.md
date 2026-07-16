# Eyeball Mocks Specification

- Repository: `eyeball-mocks`
- Status: catalog 1.0 P0 provider specification plus catalog 1.1 voice-agent coverage
- Language/runtime: TypeScript on Node.js
- HTTP framework: Hono
- Consumers: executor, SDK, MCP gateway, contract tests, and end-to-end agent loops

## 1. Purpose and conformance

`eyeball-mocks` is a standalone repository of deterministic mock provider APIs for the
Eyeball platform. It makes the full integration path buildable and testable with zero real
provider credentials.

The mocks sit behind provider adapters. They emulate provider-facing HTTP APIs; they do not
replace `POST /v1/execute`, the executor, SDK conversion, or the MCP gateway. A mock test
therefore traverses the same catalog lookup, canonical schema validation, idempotency,
`CredentialProvider`, adapter, error normalization, output validation, execution storage,
and webhook code used with a real provider.

This specification is subordinate to the canonical contracts in `PROVIDERS.md`, RFC 001,
and RFC 002. When a provider mock intentionally differs from a vendor, the difference MUST
not change the canonical tool's observable contract.

Normative terms `MUST`, `MUST NOT`, `SHOULD`, and `MAY` are used as requirements.

## 2. Goals and non-goals

### 2.1 Goals

- Start the combined P0 server in less than two seconds on a typical CI runner.
- Require no provider account, API key, OAuth client, carrier, media service, or network access.
- Produce deterministic responses, identifiers, timestamps, pagination, and event ordering.
- Preserve state across requests so canonical create, read, update, list, and delete flows work.
- Exercise realistic provider auth failures, including HTTP 401, 403, and 429 response shapes.
- Drive RFC 001 error normalization rather than returning normalized Eyeball errors directly.
- Exercise token expiry, refresh, async jobs, rate-limit windows, and voice lifecycle transitions.
- Support isolated reset and seed operations for unit, contract, integration, and E2E suites.
- Let every provider adapter change from mock to real by swapping only base URL and credentials.
- Keep fixtures obvious, reviewable, safe to publish, and stable across operating systems.

### 2.2 Non-goals

- Byte-perfect emulation of every vendor field, undocumented quirk, or transport detail.
- Provider performance, load, latency, capacity, or soak testing.
- Proof that OAuth consent screens, DNS, carrier networks, or public webhooks work in production.
- Reimplementation of the Eyeball executor, catalog, canonical schemas, or adapter normalization.
- Realistic secret generation or a security boundary for untrusted callers.
- P1 or P2 provider mocks at P0 launch.
- Live LLM-driven callers, nondeterministic speech, or external media generation in CI.

## 3. Architecture

### 3.1 Provider apps and mockhouse

Each P0 provider exports a composable Hono application. A provider app owns its vendor-like
routes, auth middleware, resource store, fixture schema, ID allocator, and behavior scripts.
Apps MUST accept injected stores, clock, and ID factory; they MUST NOT read wall-clock time or
generate random values directly.

The `mockhouse` binary composes every app into one process and mounts it under a stable path
prefix:

```text
http://127.0.0.1:<port>/gmail/...
http://127.0.0.1:<port>/slack/...
http://127.0.0.1:<port>/twilio/...
http://127.0.0.1:<port>/stripe/...
```

Every catalog 1.0 P0 provider slug has a `baseUrls` entry and matching path prefix. The eight social-data
prefixes delegate to one internal ScrapeCreators mock service while retaining distinct public
base URLs and fixture namespaces.
Every P0 manifest exercised through HTTP MUST declare RFC 001's trusted
`endpoint.baseUrlOverrideEnv`. Test bootstrap maps each returned `baseUrls` value to that
manifest-declared variable; `eyeball-mocks` does not introduce an aggregate production
override or let a request select its destination.

Provider packages MAY also launch an app alone for focused tests. Standalone and combined
servers MUST use the same handlers and stores; `mockhouse` cannot maintain a second behavior
implementation.

### 3.2 In-memory state

All P0 state is in memory. Stores expose typed operations for resource CRUD, pagination,
scheduled transitions, webhook attempts, token grants, and rate-limit counters. A test process
owns its state and discards it on shutdown.

Seeded IDs use `<resource>_<seed>_<sequence>`, such as `msg_default_0001`. Sequence counters
reset with state. Fixture timestamps are derived from the controllable clock. Sorting MUST use
explicit stable keys, and pagination cursors MUST encode stable offsets or fixture IDs.

No mock code may call `Math.random()`, `crypto.randomUUID()`, or `Date.now()` for observable
values. Tests that run concurrently SHOULD start one server per worker. Suites sharing a server
MUST serialize reset/seed operations.

### 3.3 Control plane

`mockhouse` exposes an out-of-band control plane at `/_mock`. Control routes are not provider
routes and adapters MUST never call them.

| Method and route | Purpose | Required behavior |
|---|---|---|
| `POST /_mock/reset` | Clear selected or all state | Reset stores, counters, scripts, grants, limits, and clock |
| `POST /_mock/seed` | Load a named or inline fixture bundle | Validate atomically; reject unknown providers and duplicate IDs |
| `POST /_mock/clock/advance` | Move simulated time forward | Run every due transition and emit ordered events before returning |

`reset` accepts `{ "providers"?: string[] }`; omission means all mounted providers. `seed`
accepts `{ "bundle"?: string, "providers"?: Record<string, unknown> }`. Exactly one named
bundle or inline provider map MUST be supplied. `clock/advance` accepts a positive
`{ "milliseconds": number }` and returns the new ISO timestamp plus transition counts.

Control operations MUST complete only after all synchronous consequences are visible. Seed is
transactional: invalid input leaves prior state untouched. The control plane binds to loopback
and is test-only; it is not designed as an authenticated production API.

### 3.4 Mock-kit API

```ts
export type P0Provider = /* the 34 catalog 1.0 slugs in section 6 */ string;

export interface MockServer {
  baseUrls: Readonly<Record<P0Provider, string>>;
  reset(options?: { providers?: readonly P0Provider[] }): Promise<void>;
  seed(input: { bundle: string } | { providers: Record<string, unknown> }): Promise<void>;
  advanceClock(milliseconds: number): Promise<{ now: string; transitions: number }>;
  close(): Promise<void>;
}

export declare function startMockServer(options: {
  providers: readonly P0Provider[];
  host?: "127.0.0.1";
  port?: number;
  initialTime?: string;
}): Promise<MockServer>;
```

Port `0` requests an available local port and is the library default. The CLI uses a configured
fixed port. `baseUrls` contains only requested providers and is available after the listener is
ready.

## 4. Fidelity levels

Fidelity is assigned per provider, not per package. A higher level includes every requirement
of the lower levels.

### 4.1 L1: contract-shape fidelity

L1 provides the routes used by the P0 adapter, realistic provider request/response envelopes,
stable pagination, and stateful CRUD. It enforces required provider fields, returns vendor-like
not-found and validation failures, and supports the standard auth-trigger tokens.

L1 is sufficient to prove canonical input mapping, provider output mapping, state persistence,
pagination, error sanitization, and manifest omissions that normalize to `not_supported`.

### 4.2 L2: behavioral fidelity

L2 adds deterministic state machines and time-dependent behavior. Examples include OAuth code
consumption, token expiry and refresh, fixed-window rate limits, Stripe payment/refund state,
call ringing/connection/completion, room participant lifecycle, and deterministic STT/TTS.

No L2 transition may require a wall-clock sleep. Tests advance time through the control plane.
Retries, replay, and idempotency-sensitive cases MUST be scriptable.

### 4.3 L3: interactive fidelity

L3 adds multi-turn, event-driven interaction. At P0 it applies to the Pipecat voice pipeline and
the shared scripted-caller harness used across the voice stack.

Caller fixtures contain ordered utterances, delays, interruptions, hangup, DTMF, and expected
agent prompts. STT maps stable fixture audio IDs to timed text; TTS maps text to stable fixture
audio IDs. A text-in/text-out fast path avoids binary audio. The controllable clock drives
ringing, connection, silence, barge-in, maximum duration, wrap-up, failure, and abandonment.

The harness emits ordered streaming transcript and lifecycle events in the same transcript
artifact shape as real voice sessions. Fixtures declare allowed tool calls, canonical inputs,
order, results or normalized errors, and required session/user correlation. Unexpected calls
fail the test. It MUST use `MockCredentialProvider`, the normal executor, real schema validation,
and real allowlist enforcement; it MUST NOT add a test-only `VoiceAgentDefinition` field.

## 5. Authentication simulation

### 5.1 MockCredentialProvider fixtures

All mock executions resolve credentials through RFC 001's `MockCredentialProvider`.
Credentials use `fixture:`-prefixed secrets and are selected by project, user, toolkit, and
optional connection ID exactly as real credentials are selected.

Default fixture bundles include valid API key, Basic, no-auth, and OAuth2 credentials. OAuth2
fixtures include scopes, expiry, and an optional `refreshTo` credential. Credentials MUST stay
inside executor memory and MUST NOT appear in mock logs, traces, resource state, output,
webhooks, or error detail.

### 5.2 OAuth endpoints

OAuth-capable provider apps assigned L2 expose these deterministic routes under their provider prefix:

| Route | Behavior |
|---|---|
| `GET /_mock/oauth/authorize` | Validate client, redirect URI, state, scopes, and issue a one-use code |
| `POST /_mock/oauth/token` with `authorization_code` | Consume the code and issue access/refresh tokens |
| `POST /_mock/oauth/token` with `refresh_token` | Rotate or reject refresh tokens per fixture script |
| `POST /_mock/oauth/revoke` | Mark an access or refresh token unusable |

Mounted URLs are `<provider-prefix>/_mock/oauth/...`; the global `/_mock` namespace remains the
server control plane. Authorization codes are single use and expire against the simulated clock.
Token responses include realistic `token_type`, `expires_in`, `scope`, and provider-specific
envelopes where the adapter depends on them.

At catalog 1.0 P0, Gmail is the L2 OAuth mock. L1 OAuth provider mocks accept fixture credentials
and return their vendor-shaped auth failures, but do not claim full authorization-code and refresh
state-machine fidelity. The complete authorize to code to token to refresh to expiry sequence MUST
be testable for every L2 OAuth mock without a browser. Consent UI appearance is intentionally not
emulated.

### 5.3 Trigger tokens and error shapes

These literal access-token fixtures are reserved across all applicable providers:

| Token | Provider response | Expected RFC 001 code |
|---|---|---|
| `fixture:EXPIRED_TOKEN` | Vendor-shaped HTTP 401 | `auth_expired` |
| `fixture:INSUFFICIENT_SCOPE_TOKEN` | Vendor-shaped HTTP 403 | `auth_insufficient_scope` |
| `fixture:RATE_LIMITED_TOKEN` | Vendor-shaped HTTP 429 with retry metadata | `rate_limited` |

Each provider family returns its own realistic error envelope, provider error code, request ID,
and safe detail. The mock MUST NOT return `NormalizedToolError` from a provider route. Adapters
must map those failures into RFC 001's closed taxonomy, including retryability and `retryAfter`.

Fixtures also cover missing resources, provider outage, invalid provider payload, timeout before
side effect, unsupported operation, and refresh rejection. Error bodies MUST contain no fixture
secret or authorization header.

The real-auth swap invariant is strict: selecting a real target changes provider base URL and
the `CredentialProvider` implementation or fixture only. Canonical input, adapter code, executor
configuration, schemas, assertions, and contract-test body remain unchanged.

## 6. P0 mock inventory

The inventory contains exactly the 34 catalog 1.0 P0 provider slugs from `PROVIDERS.md`. L2 and L3 include
L1 behavior.

RFC 002 adds the native P0 `voice-agents` toolkit in catalog 1.1. It is not part of the frozen
34-provider catalog 1.0 count; its resource and session fixtures live in `packages/mocks-voice`
and compose with the Pipecat L3 scripted-caller harness.

| Provider | Fidelity | Stateful resources | Key behaviors | Error scenarios |
|---|:---:|---|---|---|
| `gmail` | L2 | messages, threads, drafts, labels, OAuth grants | send/reply/search, pagination, token refresh, send quota window | 401 expired, 403 scope, 404 message, 429 quota |
| `microsoft-outlook` | L1 | mailboxes, folders, messages, drafts, threads | send/reply/list/search, folder/category mutation | 401 expired, 403 scope, 404 message, 429 throttled |
| `google-calendar` | L1 | calendars, events, attendees, free/busy slots | create/update/cancel, recurrence fixtures, availability | 401 expired, 403 calendar ACL, 404 event, 429 quota |
| `slack` | L1 | workspaces, channels, members, messages, reactions | post, thread reply, cursor pagination, channel creation | invalid_auth, missing_scope, channel_not_found, ratelimited |
| `discord` | L1 | guilds, channels, members, messages, reactions | post/reply/list, snowflake-like seeded IDs | 401 token, 403 permission, 404 channel, 429 bucket |
| `telegram` | L1 | bots, chats, members, messages | send/reply/list, update-style fixtures | 401 bot token, 403 blocked, 400 chat missing, 429 retry_after |
| `whatsapp-business` | L1 | accounts, phone numbers, contacts, messages | send and retrieve status, template/text fixtures | 401 token, 403 permission, 404 message, 429 limit |
| `twilio` | L2 | calls, call legs, recordings, DTMF, SMS records | ringing to active to terminal, transfer/end, scripted caller bridge | 401, 403, 404 call, 429, carrier failure, timeout |
| `livekit` | L2 | rooms, participants, tracks, grants, events | room/participant lifecycle, join tokens, transcript event transport | 401, 403 grant, 404 room, 429, disconnect |
| `pipecat` | L3 | pipelines, sessions, turns, tool assertions, transcripts | scripted fake-human caller, barge-in, DTMF, ordered streaming | auth, unexpected tool, prompt mismatch, silence, abandonment |
| `elevenlabs` | L2 | voices, synthesis jobs, fixture audio | deterministic text to audio ID, format/voice validation | 401, 403 voice, 404 voice, 429 credits, synthesis failure |
| `deepgram` | L2 | transcription jobs, streams, fixture audio, timed words | deterministic audio ID to transcript, partial/final events | 401, 403 scope, 404 audio, 429, malformed media |
| `hubspot` | L1 | contacts, companies, deals, activities, notes | CRM CRUD, search, associations, cursor pagination | 401, 403 scope, 404 object, 429 |
| `odoo` | L1 | partners, invoices, bills, accounts, journals, payments | ERP CRUD, issue/send invoice, balanced journal validation | auth fault, access fault, missing record, validation fault |
| `quickbooks` | L1 | customers, invoices, bills, accounts, payments | accounting CRUD, sync-token fixture, invoice/payment links | 401, 403 realm, 404 entity, 429, stale object |
| `instagram-data` | L1 | shared ScrapeCreators profiles, posts, comments | per-platform fixtures via one service; profile/content discovery | 401 key, 404 content, 429 credits, upstream error |
| `tiktok-data` | L1 | shared ScrapeCreators profiles, videos, comments | per-platform fixtures; search, trending, transcript where supported | 401 key, 404 video, 429 credits, upstream error |
| `youtube-data` | L1 | shared ScrapeCreators channels, videos, comments, transcripts | channel videos, search, live metadata, transcripts | 401 key, 404 video, 429 credits, transcript unavailable |
| `x-data` | L1 | shared ScrapeCreators profiles, posts, communities | profile, post, community, and video-transcript fixtures; no general search | 401 key, 404 post, 429 credits, upstream error |
| `linkedin-data` | L1 | shared ScrapeCreators people, companies, posts | profile/company/post lookup only where adapter supports it | 401 key, 404 entity, 429 credits, unsupported surface |
| `reddit-data` | L1 | shared ScrapeCreators subreddits, posts, comments | community/post/comment retrieval and search | 401 key, 404 post, 429 credits, upstream error |
| `twitch-data` | L1 | shared ScrapeCreators profiles, videos, schedules, clips | profile, user-video, schedule, and clip-detail fixtures | 401 key, 404 profile/clip, 429 credits, offline content |
| `snapchat-data` | L1 | shared ScrapeCreators profiles | public-profile fixtures only; no posts, stories, comments, search, or transcript | 401 key, 404 profile, 429 credits, unsupported surface |
| `google-drive` | L1 | drives, files, folders, permissions, exports | CRUD, move/share, upload/download refs, native export | 401, 403 ACL/scope, 404 file, 429 quota |
| `google-sheets` | L1 | spreadsheets, worksheets, ranges, rows | range reads/writes, append, stable tabular values | 401, 403 sheet, 404 range, 429 quota, invalid range |
| `airtable` | L1 | bases, tables, views, records | record CRUD, filters, views, cursor pagination | 401, 403 base, 404 table/record, 429 |
| `notion` | L1 | workspaces, pages, databases, blocks, records | search/list, page and database-row CRUD | 401, 403 capability, 404 page, 429 |
| `github` | L1 | repos, issues, comments, pull requests, commits, runs | issue CRUD, review comments, build/deployment reads | 401, 403 scope/rate, 404 repo, 422 validation |
| `linear` | L1 | workspaces, teams, projects, issues, comments | issue CRUD, project listing, stable GraphQL cursors | 401, 403 team, GraphQL not-found, 429 |
| `stripe` | L2 | customers, payment links, payments, refunds, invoices, subscriptions | payment/refund/subscription state machines, idempotency replay | 401, 403, 404 object, 409 replay mismatch, 429 |
| `shopify` | L1 | products, variants, inventory, orders, fulfillments, customers | catalog/order CRUD, inventory adjustment, fulfillment | 401, 403 scope, 404 object, 429, stale inventory |
| `zendesk` | L1 | users, tickets, replies, agents, groups, conversations | ticket CRUD, assign, public reply/internal note | 401, 403 role, 404 ticket, 429 |
| `firecrawl` | L1 | scrape jobs, crawl jobs, pages, maps, extractions | page fetch, bounded crawl, extraction, sitemap, screenshot refs | 401 key, 404 page, 429 credits, crawl failure |
| `serper` | L1 | search requests and ranked result fixtures | deterministic query matching, locale/page fixtures | 401 key, 400 query, 429 credits, upstream unavailable |

Catalog 1.0 P0 provider fidelity totals are **27 L1**, **6 L2**, and **1 L3**. The L2 set is Gmail, Twilio,
LiveKit, ElevenLabs, Deepgram, and Stripe. Pipecat is the L3 owner; its scripted-caller
harness composes with every voice provider mock.

## 7. Canonical surface coverage

Provider apps implement only tools declared by their manifests. Shared capability handlers use
the canonical lists below; provider subsets remain explicit and missing tools must normalize to
`not_supported` rather than being silently synthesized.

| Capability | Canonical operations covered by P0 mocks |
|---|---|
| Email | `send_email`, `list_emails`, `get_email`, `reply_to_email`, `create_draft`, `search_emails`, `list_threads`, `add_email_label` |
| Calendar | `list_calendars`, `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `find_available_times`, `create_scheduling_link`, `respond_to_event` |
| Messaging | `send_message`, `list_channels`, `list_messages`, `get_message`, `reply_to_message`, `add_reaction`, `create_channel`, `list_members` |
| Voice | `start_call`, `get_call`, `list_calls`, `end_call`, `transfer_call`, `send_dtmf`, `create_room`, `join_room`, `synthesize_speech`, `transcribe_audio`, `start_voice_pipeline`, `get_voice_pipeline` |
| Voice agents (catalog 1.1) | `create_voice_agent`, `get_voice_agent`, `list_voice_agents`, `update_voice_agent`, `delete_voice_agent`, `start_agent_call`, `attach_agent_to_number`, `get_agent_session`, `list_agent_sessions`, `get_session_transcript`, `send_session_message` |
| SMS | `send_sms`, `get_sms`, `list_sms`, `send_mms`, `get_delivery_status`, `send_verification_code`, `check_verification_code` |
| CRM | contact/company/deal CRUD subsets, `list_activities`, `add_note` |
| ERP/accounting | customer, invoice, bill, payment, account, journal, and record-search operations |
| Social data | profile, post, comment, creator, transcript, channel, live, audience, and trending subsets documented per platform |
| Files/docs | list/get/search/upload/download/move/delete files, create folders, sharing, and document export |
| Sheets/databases | row CRUD/search/append, range reads/writes, table listing, and provider-supported queries |
| Project/dev | project, issue, comment, task, pull-request, commit, build, and deployment subsets |
| Payments | payment links, payments, refunds, customers, subscriptions, and invoices |
| E-commerce | products, inventory, orders, fulfillment, and customers |
| Support | tickets, assignment, replies, and conversation operations |
| Web | `web_search`, `get_page_content`, `crawl_site`, `extract_structured_data`, `get_sitemap`, `take_screenshot` |

## 8. Repository layout and fixtures

```text
eyeball-mocks/
  apps/mockhouse/                 # combined CLI and server composition
  packages/shared/mock-kit/       # clock, stores, IDs, auth, controls, server API
  packages/mocks-email/           # Gmail, Microsoft Outlook
  packages/mocks-messaging/       # Slack, Discord, Telegram, WhatsApp Business
  packages/mocks-voice/           # Twilio, LiveKit, Pipecat, ElevenLabs, Deepgram, voice-agents
  packages/mocks-business/        # HubSpot, Odoo, QuickBooks, Stripe, Shopify, Zendesk
  packages/mocks-productivity/    # Calendar, Drive, Sheets, Airtable, Notion, GitHub,
                                  # Linear, Firecrawl, Serper
  packages/mocks-social/          # one ScrapeCreators service, eight toolkit adapters
  fixtures/p0-default/            # committed JSON seed bundle
  fixtures/scenarios/             # expiry, limits, async, failure, and voice scripts
  tests/contracts/                # mockhouse and provider-package conformance
```

### 8.1 Package responsibilities

`shared/mock-kit` owns no provider routes. It supplies `startMockServer`, Hono composition,
control handlers, the simulated clock, deterministic IDs, store primitives, auth triggers,
fixture validation, and shared test assertions.

Capability packages export provider app factories and typed fixture schemas. Package boundaries
reduce install cost for focused adapter tests while `mockhouse` supplies one P0 binary for E2E.

### 8.2 Fixtures

All seed data is JSON. Values are obviously fake but structurally realistic: domains use
`acme.example` or reserved example domains, North American telephone fixtures use the reserved
`+1 555` range, and names describe roles such as `Avery Example` or `Test Support Agent`.

Fixtures MUST NOT contain copied production payloads, real personal data, live credentials,
reachable webhook URLs, or non-reserved domains presented as customer data.

Every bundle declares a schema version, initial clock, provider sections, deterministic ID seed,
and expected resource counts. Scenario overlays may add behavior scripts but may not mutate the
base bundle on disk. Object key order is irrelevant; list order is explicit and stable.

Required launch scenarios are `p0-default`, `auth-errors`, `oauth-refresh`, `rate-limit-window`,
`async-success`, `async-failure`, `voice-happy-path`, `voice-barge-in`, `voice-hangup`, and
`voice-unexpected-tool`, plus `voice-chat-turn` for new-session and continued-session message
semantics.

## 9. Test-harness integration

### 9.1 NPM exports

Packages expose app factories by provider and fixture builders by capability. Representative
exports are:

```json
{
  "@eyeball/mock-kit": ["startMockServer", "createTestClock", "MockCredentialProviderFixtures"],
  "@eyeball/mocks-email/gmail": ["createGmailMock", "gmailFixtures"],
  "@eyeball/mocks-messaging/slack": ["createSlackMock", "slackFixtures"],
  "@eyeball/mocks-voice/pipecat": ["createPipecatMock", "scriptedCaller"],
  "@eyeball/mocks-business/stripe": ["createStripeMock", "stripeFixtures"],
  "@eyeball/mocks-productivity/files": ["driveFixtures", "notionFixtures"],
  "@eyeball/mocks-social/scrapecreators": ["createScrapeCreatorsMock", "platformFixtures"]
}
```

The actual `package.json` uses conditional ESM exports and TypeScript declarations. Internal
store modules are not public exports.

### 9.2 Vitest global setup

```ts
import { startMockServer } from "@eyeball/mock-kit";
import { P0_PROVIDERS } from "@eyeball/mock-kit/providers";
import { P0_PROVIDER_MANIFESTS } from "@eyeball/core/catalog";

export default async function setup() {
  const mocks = await startMockServer({
    providers: P0_PROVIDERS,
    initialTime: "2026-01-01T00:00:00.000Z",
  });
  await mocks.reset();
  await mocks.seed({ bundle: "p0-default" });
  for (const manifest of P0_PROVIDER_MANIFESTS) {
    const envName = manifest.endpoint.baseUrlOverrideEnv;
    if (!envName) throw new Error(`Missing mock base-URL override for ${manifest.toolkit.slug}`);
    process.env[envName] = mocks.baseUrls[manifest.toolkit.slug];
  }
  process.env.EYEBALL_CREDENTIAL_PROVIDER = "mock";
  return async () => mocks.close();
}
```

Individual tests call `reset`, `seed`, and `advanceClock` through a shared test context or the
HTTP control routes. Assertions wait on returned state, never arbitrary sleeps.

### 9.3 CI requirements

- Mock and contract jobs run with network egress disabled.
- The server binds only to `127.0.0.1`; tests must fail on attempted external DNS or HTTP access.
- CI records the fixture bundle version, mock package version, and simulated initial time.
- A cold-start check fails when all P0 apps take two seconds or more to become ready.
- Contract jobs run at least once from a clean install and with deterministic worker isolation.
- Logs may include fixture IDs and request IDs, but never authorization values or request bodies
  containing credentials.

## 10. Real-auth swap contract

### 10.1 Parameterized suite

Provider contracts are parameterized by this target and otherwise share the same test body:

```ts
type ContractTarget = {
  provider: P0Provider;
  target: "mock" | "real";
  baseUrl: string;
  credentials: CredentialProvider;
};
```

For `mock`, `baseUrl` comes from `startMockServer` and credentials come from
`MockCredentialProvider`. For `real`, the base URL is the vendor endpoint and credentials come
from the approved real credential implementation. Test inputs use a dedicated vendor sandbox or
test tenant and cleanup-owned resources.

A provider is **launch-certified** only when the same applicable canonical contract suite is
green against both targets. Provider-specific setup and cleanup MAY differ; canonical requests,
executor path, adapter, schema assertions, error-code assertions, and success assertions MUST
not differ. Unsupported provider subsets are asserted from the same manifest in both targets.

The real suite is a release gate run after mock conformance, with credentials provisioned only
for that isolated job. Adding real auth is the literal final integration step, not a prerequisite
for platform development.

### 10.2 What mocks cannot certify

| Mock limitation | Real-pass coverage |
|---|---|
| OAuth consent UX, tenant policy, and redirect registration | Complete an interactive grant in a dedicated test tenant and verify stored scopes |
| Exact vendor rate-limit buckets, headers, and account-specific quotas | Run bounded quota probes and verify the adapter maps observed 429 metadata safely |
| Public webhook reachability, signature delivery, retries, and DNS/TLS | Send vendor events to a temporary public receiver and verify signature and redelivery |
| Undocumented vendor drift and serialization quirks | Replay the canonical suite against the current vendor API and capture sanitized failures |

Mocks remain authoritative for deterministic edge cases; the real pass is authoritative for
network, account, consent, vendor policy, and current wire compatibility.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Mock behavior drifts from current provider APIs | Keep routes adapter-driven, version fixtures, and require the real launch-certification pass |
| Shared mutable state makes parallel tests flaky | One server per worker or serialized reset/seed; stable IDs and clock |
| Mock-only behavior leaks into production contracts | No test fields; provider APIs sit behind the same adapters, executor, and schemas |
| Error fixtures overfit one payload | Maintain provider-family 401/403/429 envelopes and verify sanitized normalization |
| Voice scenarios become slow or nondeterministic | Simulated clock, text fast path, stable audio IDs, ordered scripts, no live LLM |
| Social adapters imply unsupported parity | One shared service, explicit per-platform fixtures, and manifest-driven subsets |
| Fixture data is mistaken for real customer data | Reserved domains/numbers, obvious names, automated secret and domain checks |
