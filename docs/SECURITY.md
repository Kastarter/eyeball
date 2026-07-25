# Security posture

This document describes the security posture of the Eyeball open-source
executor, SDK, MCP gateway, dashboard proxy, local vault, trigger/webhook
services, and self-hosted voice worker. The private control plane has an
additional threat model in [`cloud/SECURITY.md`](../cloud/SECURITY.md).

This is an engineering security statement, not a certification. It records the
controls that exist in source and tests, the assumptions those controls depend
on, and the work that remains before a hosted production launch.

## Scope and review method

The posture pass on 2026-07-19 covered three repositories:

- the main OSS repository;
- the nested, read-only Mockhouse test-infrastructure repository; and
- the nested private cloud control-plane repository.

The review used three sequential lenses: secrets and credentials, trust
boundaries, and dependency/supply-chain exposure. It included tracked-file and
history sweeps, data-flow tracing, targeted adversarial tests, package audits,
license and lifecycle-script inventories, and workflow pin review. It did not
include external penetration testing, live-provider certification, or a formal
cryptographic audit.

The 2026-07-24 pre-release delta review applied the same three lenses to the
exact ranges `93d22a1..1743c4c` in main (38 commits) and
`eafe9a2..7ece86b` in the private cloud repository (10 commits), plus the
current read-only Mockhouse tree. It reviewed every changed path, fully read the
new durable/security-sensitive stores and workers, and included the fixes and
verification recorded below. The commit counts are the repository-observed
counts, rather than the approximate counts in the review request.

The 2026-07-24 pre-launch adversarial pass added a tiered fan-out review keyed
to the actual launch surface. Tier A is the only internet-exposed surface at
launch — the static landing and documentation sites at `useyeball.dev` — and was
verified clear: no server runtime, no embedded secrets, and hardened CI/publish
workflows. Tier B is the open-core executor, MCP gateway, dashboard, private
bridge spike, and self-hosted voice worker that operators run but that this
launch does not expose to hosted traffic. Every finding was verified against
source before triage, and two candidate findings did not survive that
verification and were dropped rather than recorded. The pass fixed SEC-026,
SEC-027, and SEC-028; re-confirmed SEC-007 (voice/trigger bearer material in
URLs) and SEC-008 (push ingest lacks provider-native signature verification) as
accepted upstream residuals; and recorded SEC-029 through SEC-035 as accepted,
gated residuals — self-hosted executor and worker hardening plus lower-severity
operator-tooling and CI items that this launch does not expose to hosted
traffic.

## Threat model

### Assets

- Project API keys and user-pinned API keys.
- Provider API keys, OAuth access/refresh tokens, and connection metadata.
- Local-vault encryption keys and cloud key-encryption keys (KEKs).
- Execution inputs, outputs, staged files, identities, and audit records.
- Webhook signing secrets and trigger-ingest secrets.
- Voice-worker control tokens, session grants, fallback executor keys, media
  tokens, transcripts, and call metadata.
- Cloud sessions, CSRF tokens, internal service secrets, Stripe webhook
  secrets, and tenant billing state.
- Release credentials, source integrity, lockfiles, and CI provenance.

### Actors

- An unauthenticated Internet attacker.
- An authenticated user attempting cross-user or cross-project access.
- A malicious webhook recipient, OAuth provider, SaaS provider, or DNS
  operator.
- A compromised browser, dashboard deployment, executor, voice worker, cloud
  service, database, CI runner, dependency, or operator account.
- An honest operator who accidentally logs, misroutes, or misconfigures a
  secret.

### Boundaries

```text
Untrusted browser
  |  cloud session + CSRF; explicit cookie/header allowlists
  v
Dashboard BFF -----------------------> Cloud control plane
  |  per-project HttpOnly key cookie      | DB + envelope-encrypted vault
  v                                      | internal bearer boundary
Executor <---------------------------- Cloud internal API
  ^   ^   ^
  |   |   +-- signed webhook egress --> customer endpoint / hostile DNS
  |   +------ SDK and MCP API keys
  +---------- session-scoped voice grant + reserved child IDs
  |
  +-- credentialed, no-auto-redirect HTTP --> SaaS providers

Provider push --> per-subscription trigger URL --> Executor --> signed webhook
Carrier media --> scoped media URL --> Voice worker --> Executor / providers

CI + lockfiles + pinned actions --> build and release artifacts
Mockhouse (test-only, read-only review) --> in-process provider simulations
```

The principal security property is tenant and identity confinement: a request
must remain within the project and, when applicable, the end user selected by
the credential that authorized it. Network egress and operator-controlled
configuration remain separate trust boundaries; an application-layer check is
not a substitute for production egress policy.

## Enforced guarantees

Each guarantee below points to an executable test. A passing test is evidence
for the named implementation, not proof against every implementation or
deployment error.

| Guarantee | Enforcement and evidence |
| --- | --- |
| Executor logs and telemetry redact credential fields, authorization headers, canonical bodies, file bytes, URLs, and nested secrets before emission. Upload base64 and decoded-byte sentinels are regression-tested as size-only markers. | Central wrapper in `apps/executor/src/telemetry/log.ts`; [`apps/executor/test/telemetry.test.ts`](../apps/executor/test/telemetry.test.ts). |
| Provider errors retain bounded diagnostics without exposing response secrets or configured credential values, and credentialed redirects are not followed. | `packages/toolkits/src/http-client.ts`; [`apps/executor/test/http-client.test.ts`](../apps/executor/test/http-client.test.ts). |
| Cloud audit metadata passes through recursive named-field redaction before persistence. | `cloud/apps/control/src/audit.ts`; [`cloud/apps/control/test/control.test.ts`](../cloud/apps/control/test/control.test.ts) and [`cloud/apps/control/test/vault.test.ts`](../cloud/apps/control/test/vault.test.ts). |
| The local vault encrypts every credential with AES-256-GCM, authenticates record metadata as AAD, and rejects ciphertext/AAD tampering. | `packages/core/src/local-vault.ts`; [`packages/core/test/local-vault.test.ts`](../packages/core/test/local-vault.test.ts). |
| Cloud credentials use per-record AES-256-GCM data keys wrapped by a versioned KEK; keys can be rewrapped without re-encrypting payloads. | `cloud/apps/control/src/vault/crypto.ts` and `vault/service.ts`; [`cloud/apps/control/test/vault.test.ts`](../cloud/apps/control/test/vault.test.ts). |
| Public API keys are reveal-once and cloud persistence contains only SHA-256 hashes; password records use scrypt. | `cloud/apps/control/src/app.ts`; [`cloud/apps/control/test/control.test.ts`](../cloud/apps/control/test/control.test.ts). |
| Outbound execution webhooks sign `<unix-seconds>.<raw-body>` with HMAC-SHA256 and expose the signature as `v1=<hex>`. Verification has a five-minute replay window. | `packages/core/src/webhooks.ts`; [`packages/core/test/webhooks.test.ts`](../packages/core/test/webhooks.test.ts). |
| Trigger-ingest secrets are 32 random bytes, stored only as SHA-256 hashes, compared in constant time, returned only in create/rotate URLs, and immediately invalidated on rotation. | `apps/executor/src/triggers/service.ts`; [`apps/executor/test/triggers.test.ts`](../apps/executor/test/triggers.test.ts). |
| Recent trigger-event history is project-isolated and readable only with an unpinned project key. Its memory/Postgres append boundary reconstructs a closed metadata allowlist field by field, so provider payloads and provider event IDs, push secrets, credentials, endpoint URLs, headers, signatures, and request/response bodies never persist even when unsafe properties are cast onto the input. Seven-day logical expiry and bounded physical cleanup apply in both compositions, and the dashboard performs a second allowlist projection including nested targets. | Shared memory/PGlite TriggerEventStore contracts, raw-schema/row assertions, and expiry coverage in [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts); HTTP authorization, isolation, and response allowlist coverage in [`apps/executor/test/triggers.test.ts`](../apps/executor/test/triggers.test.ts); browser-boundary and rendered-markup privacy sentinels in [`apps/dashboard/src/lib/api.test.ts`](../apps/dashboard/src/lib/api.test.ts) and [`apps/dashboard/src/components/triggers/trigger-events-tab.test.tsx`](../apps/dashboard/src/components/triggers/trigger-events-tab.test.tsx). This is recent operational history, not immutable compliance audit retention. |
| A user-pinned key cannot assert a different user or read another user's executions, connections, webhooks, or triggers. | Executor authorization in `apps/executor/src/routes.ts`; [`apps/executor/test/execution.test.ts`](../apps/executor/test/execution.test.ts) and [`apps/executor/test/triggers.test.ts`](../apps/executor/test/triggers.test.ts). Staged-file ownership is a separately documented gap. |
| Authorized execution projections expose only a monotonic replay bit, verified voice-session identity, and distinct staged-file IDs/count. They never expose a raw key or derivative, canonical request, file content, or connection selection. | Core record contract plus memory/PGlite store projection and HTTP privacy regressions in `packages/core/src/types/execution.ts`, [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts), [`apps/executor/test/execution.test.ts`](../apps/executor/test/execution.test.ts), and [`apps/executor/test/files.test.ts`](../apps/executor/test/files.test.ts). |
| Staged files are project-isolated, remain available across Postgres/PGlite executor reconstruction until expiry, expired durable rows are reclaimed online in bounded batches, persistence failures do not retain byte-bearing driver errors, and metadata routes never return content. | Shared memory/PGlite FileStore contracts, restart and continuous-runtime reclamation regressions, and forced-insert-failure error-chain coverage in [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts); HTTP isolation, metadata-only, expiry, and authorization coverage in [`apps/executor/test/files.test.ts`](../apps/executor/test/files.test.ts). |
| Historical voice-agent revisions are immutable; number bindings and executor-side session pointers pin exact revisions; project/user scopes are enforced; and definitions, bindings, pointers, and message receipts survive PGlite reconstruction. | Shared memory/PGlite AgentStore contracts and durable runtime/restart reconstruction in [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts); pinned development-session coverage in [`apps/executor/test/dev-voice-sessions.test.ts`](../apps/executor/test/dev-voice-sessions.test.ts). |
| Remote voice publication persists the complete envelope before deterministic webhook work, advances the worker cursor only after durable selected publication and terminal grant handling, fences every checkpoint with an observer lease, replays unfinished observers at startup, and reconstructs terminal transcripts from complete worker history. Retry exhaustion is durable and emits one deterministic `voice.observer.failed` signal plus structured telemetry containing only bounded identities and normalized failure metadata. | Memory/PGlite observer and source contracts plus restart recovery in [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts); lease/source races in [`apps/executor/test/postgres-voice-observer-race.test.ts`](../apps/executor/test/postgres-voice-observer-race.test.ts); two-runtime acceptance and exhaustion/redaction regressions in [`apps/executor/test/voice/remote-session-observer-restart.test.ts`](../apps/executor/test/voice/remote-session-observer-restart.test.ts), [`apps/executor/test/voice/remote-session-observer.test.ts`](../apps/executor/test/voice/remote-session-observer.test.ts), and [`apps/executor/test/hosted-composition.test.ts`](../apps/executor/test/hosted-composition.test.ts). |
| MCP session updates are atomic in memory and Postgres/PGlite, negotiated sessions and task records survive reconstruction, and persistence stores only a one-way binding over the inbound credential plus configured project/pinned-user authority rather than either bearer credential or plaintext authority. | Shared SessionStore contracts and migration/restart coverage in [`apps/mcp-gateway/test/session-store-contract.test.ts`](../apps/mcp-gateway/test/session-store-contract.test.ts); authenticated restart, authority-remap rejection, and raw-row credential-absence regressions in [`apps/mcp-gateway/test/streamable-http.test.ts`](../apps/mcp-gateway/test/streamable-http.test.ts). |
| Reserved child execution IDs require synchronous mode and an exact session-bound positive-event idempotency key before public voice source is accepted. Grant callers derive session identity from the authenticated capability; static fallback callers additionally require a user-pinned key plus matching session header, user, child ID, and key. | `apps/executor/src/routes.ts`; [`apps/executor/test/execution.test.ts`](../apps/executor/test/execution.test.ts) and [`apps/executor/test/voice-session-grants.test.ts`](../apps/executor/test/voice-session-grants.test.ts). |
| Remote voice child execution can use a short-lived HMAC capability bound to one audience, project, user, executor-owned session ID, grant ID, expiry, and immutable canonical-tool allowlist. The executor checks durable revocation on every call; the worker keeps the bearer out of snapshots/events and erases it at terminal state. | `apps/executor/src/voice-session-grants.ts`, `routes.ts`, and the memory/Postgres agent stores; cross-user/session/tool confinement, tamper, expiry, revocation, persistence, and log-redaction coverage in [`apps/executor/test/voice-session-grants.test.ts`](../apps/executor/test/voice-session-grants.test.ts), [`apps/executor/test/store-contract.test.ts`](../apps/executor/test/store-contract.test.ts), and [`apps/voice-worker/tests/test_worker.py`](../apps/voice-worker/tests/test_worker.py). |
| The dashboard forwards only allowlisted cloud cookies/headers and stores executor keys in project-scoped HttpOnly, SameSite=Strict cookies. Executor responses expose only `Content-Type`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After`; prefix matching, cookies, redirects, internal headers, and unrelated provider headers remain forbidden. Cloud and executor redirects are not followed, and responses remain `no-store`. Executor `PATCH` is exposed only for `/v1/webhooks/:endpointId`; unrelated `PATCH` paths are rejected before upstream fetch. Webhook and trigger reveal state is discarded on acknowledgement. Staged-file and trigger-event projections carry allowlisted metadata only, and Try-It submits validated `file_*` references only. | `apps/dashboard/src/lib/cloud-proxy.ts`, `executor-proxy.ts`, and `api.ts`; [`apps/dashboard/src/lib/cloud-proxy.test.ts`](../apps/dashboard/src/lib/cloud-proxy.test.ts), [`apps/dashboard/src/lib/executor-key-route.test.ts`](../apps/dashboard/src/lib/executor-key-route.test.ts), [`apps/dashboard/src/lib/api.test.ts`](../apps/dashboard/src/lib/api.test.ts), [`apps/dashboard/src/components/triggers/trigger-events-tab.test.tsx`](../apps/dashboard/src/components/triggers/trigger-events-tab.test.tsx), and [`apps/dashboard/src/components/webhooks/webhooks-screen.test.tsx`](../apps/dashboard/src/components/webhooks/webhooks-screen.test.tsx). |
| The remote voice client requires HTTPS outside loopback, rejects URL credentials/query/fragment, refuses short supplied bearer tokens, and does not follow authenticated redirects. | `packages/toolkits/src/voice/remote-session-driver.ts`; [`packages/toolkits/test/voice/remote-session-driver.test.ts`](../packages/toolkits/test/voice/remote-session-driver.test.ts). |
| The Python voice worker rejects hostname suffix tricks for loopback HTTP and uses a minimum 32-byte control token with constant-time comparison. | `apps/voice-worker/src/eyeball_voice_worker/config.py` and `app.py`; [`apps/voice-worker/tests/test_worker.py`](../apps/voice-worker/tests/test_worker.py). |
| Cloud OAuth uses signed random state, a one-time atomic state claim, PKCE S256, stored provider binding, exact callback construction, and an allowlist for post-authentication return origins. | `cloud/apps/control/src/vault/service.ts` and `app.ts`; [`cloud/apps/control/test/oauth-connect.test.ts`](../cloud/apps/control/test/oauth-connect.test.ts). |
| Stripe webhooks authenticate the timestamped raw body with HMAC-SHA256, enforce freshness, and deduplicate persisted event IDs. | `cloud/apps/control/src/billing/stripe.ts` and `billing/service.ts`; [`cloud/apps/control/test/billing.test.ts`](../cloud/apps/control/test/billing.test.ts). |

### What redaction does not guarantee

Redaction protects application-controlled executor telemetry, cloud audit
metadata, and voice-worker application access logs. It cannot clean logs
written before the request reaches the application. In particular, reverse
proxies, load balancers, APM agents, browser history, and carrier systems may
record URL paths or queries. Production infrastructure must suppress or hash
trigger-ingest URL secrets and voice media-token queries.

Do not put credentials into free-form resource names or error text. Named-field
redaction is a backstop, not a data-classification system.

## Boundary review

### Browser to dashboard proxy

The cloud proxy accepts only `/v1` paths, constructs the upstream URL itself,
forwards only `Accept`, the request `Content-Type`, the CSRF header, and the cloud
session/CSRF cookies, and returns only allowlisted content headers and the two
cloud cookies. For existing `GET`, `HEAD`, `POST`, and `DELETE` behavior, the
executor proxy exposes only `/health` and `/v1/*`; `PATCH` is allowed only for
the exact `/v1/webhooks/:endpointId` update shape and every other `PATCH` route
is rejected before upstream fetch. The proxy constructs its upstream URL,
forwards a fixed header set, reads only the selected project's server-side key
cookie, strips upstream redirects, never forwards the browser cookie header,
and returns only `Content-Type`, `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`, and `Retry-After`. It does not perform arbitrary prefix matching
and never returns cookies, redirects, authorization, internal headers, or unrelated
provider headers. Responses are always marked `no-store`, including reveal-once
create and rotation responses.

Upstream URLs must be HTTPS except for literal loopback development endpoints;
credentials, query strings, and fragments in configured base URLs are rejected.

### Dashboard to cloud

Cloud sessions are random and only an HMAC-derived session record is persisted.
Mutating requests require both the session and the server-bound CSRF token;
same-origin or explicitly allowed origins are checked. The JavaScript-readable
CSRF cookie is intentionally not an authentication credential. XSS in the
dashboard remains able to act as the user and must be addressed by normal CSP,
dependency, and output-encoding controls.

### Dashboard, SDK, agents, and MCP to executor

Project keys select one project. User-pinned keys additionally constrain all
identity-bearing reads and writes. Credential resolution is keyed by project,
user, toolkit, and optional connection, so a pinned user cannot select another
user's connection. A project-wide key is intentionally an administrative trust
credential for all users in that project, but it cannot opt into the reserved
child-ID path. MCP metadata is checked against the inbound key's pin and MCP
callers do not receive the reserved-ID header seam.

Staged-file records carry an optional owner user ID bound at upload to the
effective identity (`pinnedUserId ?? X-Eyeball-User-Id`). Upload and single-file
metadata routes remain available through the normal project/pinned middleware,
while project-wide `GET /v1/files` enumeration requires an unpinned
project-authority key. That restriction keeps the collection route from turning
SEC-017's high-entropy bearer IDs into a pinned-user enumeration surface.
Single-file metadata (`GET /v1/files/:id`) and adapter byte resolution during
execution now enforce ownership in the file-store contract: an owned record
resolves only for its owning user and fails closed for a mismatched or absent
identity, so a pinned user who learns another same-project user's file ID can no
longer read its metadata or reference its bytes (SEC-017). Owner-less records —
legacy uploads and project-scoped uploads made without a user identity — stay
project-visible for backward compatibility, so continue to treat those IDs as
project-wide bearer capabilities. The JSON upload route applies a streaming body
ceiling derived from the configured decoded-byte limit plus 16 KiB for metadata
before parsing or base64 decoding.

Execution attachment summaries may expose those same high-entropy file IDs only
inside an execution projection already authorized for the requesting project and,
for pinned keys, user. The summary contains distinct IDs and a count only; it does
not broaden file access or expose bytes or staged-file metadata.

### Executor to providers

Catalog base URLs and `endpoint.baseUrlOverrideEnv` values must be HTTP(S) and
may not contain userinfo, query, or fragment components. Provider request URLs
remain same-origin with their configured base, credentialed redirects are not
followed, and provider error text is sanitized.

The override environment is an operator trust seam, not a sandbox: an operator
who can change a permitted override can intentionally send provider credentials
to another origin. Production deployments must restrict manifest provenance,
environment mutation, and egress. Plain HTTP exists for explicit mock/self-host
configurations and must not be used for Internet credentials.

### Executor to cloud internal API

Internal routes require a constant-time-checked bearer secret and emit
`Cache-Control: no-store`. API-key verification is `POST /internal/keys/verify`
with a pre-buffer 4 KiB body limit and a 1,024-character key schema; keys are no
longer accepted in a URL query. The
protocol does not currently sign a timestamp or nonce, so a captured complete
request remains replayable until the internal secret rotates. TLS, isolated
service networking, and request-log suppression are required deployment
controls; request signing is tracked below.

### Cloud OAuth

State is random, signed, expiration-bound, stored as a hash, atomically claimed
once, and tied through encrypted intent data to the connection, provider,
scopes, return URL, and PKCE verifier. The callback uses the stored connection
and toolkit to select the same provider metadata used to start authorization,
which prevents an IdP mix-up through caller-controlled provider switching.
Redirect URIs and return URLs are exact/allowlisted; external post-login
redirects are rejected.

### Webhook egress

Registration requires HTTPS and blocks literal loopback, private, link-local,
and IPv4-mapped addresses. Delivery does not follow redirects. Delivery also
resolves the target hostname at connection time, classifies every returned
address against the same private ranges, requires the host to be uniformly
public, and pins the socket to the vetted address so it cannot be re-resolved
between check and connect; empty, unrecognized, or non-HTTPS resolutions fail
closed (SEC-002). This closes application-layer DNS rebinding and
time-of-check/time-of-use SSRF. Production should still enforce a network-layer
egress deny policy as defense in depth.

### Voice worker

The worker control API uses one high-entropy service token and versioned,
session-addressed routes. That token authorizes executor-to-worker control only;
it cannot execute provider tools. Stable child execution identities re-enter
the executor through a separate HMAC capability scoped to one audience,
project, user, session, expiry, and immutable tool allowlist. The executor owns
the session ID, persists capability identity/revocation with the session
pointer, and checks it on every child request. Public voice source is accepted only
after capability validation or the equivalent static fallback checks bind the
session header, pinned user, reserved child ID, and exact event key. The optional static pinned-key
fallback still requires one worker per trusted pinned user. Media URL tokens
are session-derived but still travel in a query; Uvicorn access logging is
disabled and upstream access logs must follow the same rule.

### Trigger ingest

The URL contains a reveal-once, per-subscription bearer secret by design. The
executor stores only its hash, gives failures a uniform not-found response, and
now supports immediate rotation. The unauthenticated route applies a streaming
1 MiB body limit before buffering or adapter parsing. URL secrecy is weaker
operationally than a header because intermediaries frequently log paths. Slack
provider-signature verification is not yet implemented, so possession of the
ingest URL is the current push-authentication control.

## Findings register

No P0 finding was identified. Priority reflects the current preview state; a
finding marked “launch gate” becomes blocking before exposing that surface to
untrusted hosted traffic.

| ID | Priority | Status | Finding and exposure | Remediation / estimate |
| --- | --- | --- | --- | --- |
| SEC-001 | P1 | Fixed | Cloud API-key verification placed a customer key in `GET /internal/keys/verify?key=`, exposing it to URL logs and caches. | Replaced with authenticated `POST`, a pre-buffer 4 KiB cap, and a bounded key schema; old `GET` and oversized bodies are tested. |
| SEC-002 | P1 | Fixed | Webhook registration blocked literal private addresses but did not resolve and pin DNS at delivery, leaving DNS-rebinding/TOCTOU SSRF. | The webhook deliverer now dials through a resolver-aware guarded transport (`webhooks/ssrf.ts`) that resolves the target at connection time, classifies every returned address against the loopback/private/link-local/CGNAT/multicast/unique-local ranges, rejects any host that is not uniformly public, and pins the socket to the vetted address so it cannot be re-resolved between check and connect. It is the default transport in both the engine and runtime compositions, fails closed on empty or unrecognized resolutions and non-HTTPS targets, and reuses the same classification as registration. Socket-free rebinding regression coverage is in `apps/executor/test/ssrf.test.ts`. |
| SEC-003 | P1 | Open, bridge gate | `@activepieces/shared` brings unpatched `expr-eval@2.0.2`; [GHSA-8gw3-rxh4-v6jx](https://github.com/advisories/GHSA-8gw3-rxh4-v6jx) and [GHSA-jc85-fpwf-qm7x](https://github.com/advisories/GHSA-jc85-fpwf-qm7x) permit prototype pollution/code execution when attackers control expressions or evaluation variables. The bridge remains a private spike and must not accept untrusted formulas. | Replace with a maintained compatible fork and run formula compatibility/security tests, or remove formula evaluation; 1–2 days. No patched `expr-eval` release exists. |
| SEC-004 | P1 | Fixed | One static voice-worker key authorized every session on a worker, preventing a safe multi-user authority model. | Added short-lived, audience/project/user/session/tool-scoped HMAC capabilities, executor-owned session IDs, durable grant identity/revocation, terminal cleanup, and a v2 worker contract. The static pinned key remains an explicitly documented single-user compatibility fallback. |
| SEC-005 | P1 | Fixed | After the 14-day cloud billing grace period, existing keys and connections continued executing indefinitely; only creation was blocked. | Cloud usage reservation and credential resolution now enforce restriction after grace, payment recovery lifts it immediately, identity-only key verification stays separate, and a future-expiring internal-secret-guarded operator exemption is audited with a bounded reason. |
| SEC-017 | P1 | Fixed | Staged files were project-scoped rather than user-owned. A pinned user who learned another same-project user's high-entropy file ID during its TTL could retrieve metadata or reference those bytes in an execution. | Staged files now carry an optional owner user ID bound at upload to the effective identity (`pinnedUserId ?? X-Eyeball-User-Id`). The file-store contract enforces ownership on single-file metadata (`GET /v1/files/:id`) and on adapter byte resolution during execution: an owned record resolves only for its owner and fails closed for a mismatched or absent identity, while owner-less legacy/project-scoped uploads stay project-visible for backward compatibility. The `0010_staged_file_owner` migration adds the nullable column, and `apps/executor/test/files.test.ts` adds cross-user metadata and adapter-resolution regression coverage. Project-wide `GET /v1/files` remains unpinned-only. |
| SEC-022 | P1 | Fixed | Usage-gate transport and protocol failures defaulted fail open in the full hosted executor composition, so degrading the Cloud usage service could bypass quota admission and permit unbounded unbilled executions. | Unset `EYEBALL_USAGE_STRICT` now defaults fail closed when `EYEBALL_CREDENTIALS=cloud` and remains fail open for self-hosted composition. Explicit `1`/`true` and `0`/`false` overrides are honored, invalid values fail startup, and a structured startup log exposes the resolution and warns on hosted relaxation. |
| SEC-006 | P2 | Open | Internal cloud bearer authentication has no timestamp, nonce, or body signature; captured requests are replayable while the shared secret is valid. | HMAC-sign method/path/body hash/timestamp, enforce a short window, and persist/deduplicate nonces; 2–4 days. |
| SEC-007 | P2 | Mitigated, open | Trigger and voice media bearer material appears in URLs. App access logging is suppressed, but upstream/browser/carrier logging is outside application control. | Infra log redaction/suppression, retention tests, and prefer header/subprotocol tokens where carriers permit; 1–2 days. |
| SEC-008 | P2 | Open | Push trigger ingest does not verify provider-native signatures; the high-entropy URL is the sole Slack push credential. | Verify provider signature and freshness against a separately stored provider secret before normalization; 2–4 days. |
| SEC-009 | P2 | Open | `@ai-sdk/provider-utils@3.0.12`, transitively used only by the Activepieces spike, has the Low availability advisory [GHSA-866g-f22w-33x8](https://github.com/advisories/GHSA-866g-f22w-33x8). The advisory names `3.0.98` as its patched floor, but the registry's current 3.x line ends at `3.0.30`. | Upgrade/remove the Activepieces framework path when a compatible fixed line exists; about 1 day plus compatibility work. |
| SEC-010 | P2 | Open | Voice-worker direct Python dependencies are exact-pinned, but there is no hash-locked transitive dependency file and `pip-audit` is not installed in the repository workflow. | Generate a reproducible, hashed lock for base/media/dev groups and run `pip-audit` in CI; 0.5–1 day. |
| SEC-011 | P2 | Open | The five Activepieces piece packages plus framework/shared omit license fields in their published package manifests. | Complete source/license provenance and redistribution review before catalog promotion; 1–2 days with counsel follow-up as needed. |
| SEC-012 | P2 | Fixed | Authenticated dashboard/provider/webhook/voice clients could have followed redirects, risking credential forwarding or confusing boundary behavior. | All reviewed authenticated fetches now use manual redirect handling with regression tests. |
| SEC-013 | P2 | Fixed | Trigger ingest secrets had no API rotation path. | Added project/user-authorized rotation; the old URL becomes invalid immediately. |
| SEC-014 | P2 | Fixed | Voice loopback validation accepted hostname prefix forms such as `127.attacker.example`, and supplied remote-worker tokens could be short. | Parse literal IPs, allow only explicit local names, require HTTPS elsewhere, and enforce 32-character supplied tokens. |
| SEC-015 | P2 | Fixed | CI action tags and the nested Mockhouse checkout were mutable supply-chain references. | All actions and the Mockhouse revision are pinned to full commit SHAs. |
| SEC-016 | P2 | Fixed, basic control | The repository had no offline credential-pattern gate. | Added `scripts/check-secrets.ts`, regression tests, and the guard to root lint. Add gitleaks with an audited allowlist in production CI. |
| SEC-018 | P2 | Fixed | Transitive `esbuild<=0.24.2` and `postcss<8.5.10` fell in the Moderate ranges for [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) and [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93). | Workspace overrides select `esbuild@0.25.12` and `postcss@8.5.10`; the cloud lock also overrides the old esbuild path. Current audits no longer report either advisory. |
| SEC-019 | P2 | Fixed | Unauthenticated trigger ingest buffered an unbounded body before checking the path credential, enabling memory-pressure denial of service. | Added Hono's streaming body limiter at 1 MiB before route parsing, with an oversized-body regression test. |
| SEC-020 | P2 | Fixed | Webhook private-host validation accepted root-dot local names such as `localhost.`; alternate IPv4 literals also needed explicit regression coverage. | Strip terminal DNS root dots before classification and test decimal, hexadecimal, octal, short-form, encoded-dot, local-name, IPv6, and IPv4-mapped loopback inputs. DNS resolution and rebinding remain SEC-002. |
| SEC-021 | P2 | Fixed | Authenticated staged-file uploads enforced their decoded-byte limit only after buffering and parsing the JSON body, allowing memory-pressure denial of service above the configured limit. | Added Hono's streaming body limiter before JSON parsing, sized for canonical base64 plus 16 KiB of metadata, with an oversized-body regression test. |
| SEC-023 | P2 | Fixed | The live token-import CLI read credential material only from the environment, but silently ignored unknown argv, so an operator typo such as `--token <secret>` would leave the secret in shell history and the process table while the command continued. Unexpected provider/vault errors were also rendered verbatim. | Added a strict allowlist parser for non-secret selectors, rejected positional/unknown/duplicate argv without echoing values, and made unexpected provider/vault failures render a constant message. Seven regression cases cover access-token aliases, positional values, duplicates, invalid types, and cause redaction. |
| SEC-024 | P2 | Fixed | The voice worker temporarily stores an active session grant in SQLite for crash recovery, but the database file inherited the host umask and could therefore be group/world-readable on a permissive deployment. | Pre-create/open the configured database with no symlink following where supported, force owner-only `0600` mode before SQLite opens it, retain terminal token erasure, and test correction of a pre-existing `0666` file. |
| SEC-025 | P2 | Open, accepted for preview isolation | Voice-session grants are signed by the executor and tightly scope project, user, session, tools, child execution IDs, expiry, and durable revocation, but their audience is service-wide and they remain bearer tokens. Theft permits replay from a different worker/process until expiry or revocation; there is no worker-bound proof of possession. | Bind grants to a deployment/worker audience plus mutually authenticated worker identity or use proof-of-possession request signing. Until then, keep worker control/SQLite access isolated, use short grants, and revoke on every terminal/failure path; 2–4 days. |
| SEC-026 | P2 | Fixed | The MCP gateway compared its inbound bearer admission key with variable-time string equality, leaving a timing side-channel on the gateway key. | Length-guarded `crypto.timingSafeEqual` comparison in `apps/mcp-gateway/src/index.ts`; commit `42fb3bc`. |
| SEC-027 | P2 | Fixed | The self-hosted dashboard returned no framing, MIME-sniffing, or referrer response headers, leaving clickjacking and content-type-confusion exposure. | Added `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`, plus `poweredByHeader: false`, in `apps/dashboard/next.config.ts`; commit `42fb3bc`. |
| SEC-028 | P2 | Fixed | The dashboard server-rendering path (`cloud-server.ts`) copies the browser session and CSRF cookies into an outbound `Cookie` header, but its `configuredCloudUrl()` accepted any `http:` `EYEBALL_CLOUD_URL`, so a misconfigured non-loopback origin would forward those authenticated cookies in cleartext. | Delegated to the strict shared `configuredCloudControlUrl()` validator the browser proxy already enforces (https, loopback-http only, no embedded credentials/query/fragment); covered by `apps/dashboard/src/lib/cloud-proxy.test.ts`. Commit `a8364ff`. |
| SEC-029 | P2 | Open, accepted (self-hosted executor) | Several self-hosted executor paths perform unbounded or unthrottled work: the public `/v1/ingest/*` route is exempt from the request rate limiter and bounded only by the 1 MiB body cap (`routes.ts` middleware), `/v1/execute` parses its JSON body with no size ceiling (`routes.ts`), the Cloud remote key verifier issues one upstream fetch per distinct unseen key before per-project throttling applies (`api-key-authenticator.ts`), and the polling scheduler iterates every active subscription each tick (`triggers/service.ts`). Each is an operator- or authenticated-scope resource-exhaustion surface on a self-hosted executor, not a hosted-launch surface. | Add pre-auth ingest throttling/concurrency bounds, an `/v1/execute` body ceiling, remote-verify request coalescing and negative-flood protection, and paged subscription polling; 1–2 days. |
| SEC-030 | P2 | Fixed | The Python voice worker loads `LIVEKIT_URL` without the `_secure_service_url()` guard applied to the executor and public URLs, so a `ws://` LiveKit endpoint would carry room/join media tokens over cleartext. | `LIVEKIT_URL` now passes through `_secure_ws_url()` in `config.py`, which requires `wss://` (allowing `ws://` only for loopback, `.localhost`, and `host.docker.internal`) and rejects embedded credentials, query, or fragment, mirroring the remote-session HTTPS rule (SEC-014); regression coverage in `apps/voice-worker/tests/test_worker.py`. Commit `183d8fe`. |
| SEC-031 | P2 | Open, accepted (self-hosted executor) | The executor `webhook_endpoints` table stores each endpoint's HMAC signing `secret` in plaintext at rest (`schema.ts`), so a database compromise discloses the secrets needed to forge delivery signatures. | Encrypt the signing secret at rest through the local/cloud vault seam or store a derivable form, coordinated with delivery signing; 1–2 days. |
| SEC-032 | P3 | Open, accepted (local operator CLI) | `scripts/eyeball-auth.ts` accepts secret material on argv (`--secret`, `--client-secret`), prompts for secrets through an echoing readline, and writes `EYEBALL_VAULT_KEY` to stdout on `init`, leaving secrets in shell history, the process table, and terminal scrollback. This is a distinct local CLI from the hardened token-import CLI (SEC-023). | Reject secret-bearing argv, read secrets from stdin without echo, and write the vault key to a `0600` file; local-operator convenience tool with no network exposure; 0.5–1 day. |
| SEC-033 | P3 | Open, accepted | The public SDK TSDoc example for `webhooks.create` logs the reveal-once endpoint secret (`console.log(endpoint.secret)` in `packages/sdk/src/client.ts`), modeling insecure handling of a sensitive value in generated public docs. | Replace the example with non-secret logging and regenerate the checksum-guarded SDK docs via `scripts/generate-sdk-docs.ts` and the `docs:*` gates; under 0.5 day. |
| SEC-034 | P3 | Fixed | `scripts/check-secrets.ts` skipped tracked text files larger than its size limit with a warning but exit 0, so an oversized tracked text file would bypass the offline secret gate, contradicting the "scan every existing tracked text file" requirement. No tracked text file currently exceeds the limit. | Oversized tracked text files are now streamed through `scanLargeText()` in overlapping windows (64 KiB overlap, larger than any matched token) instead of skipped, so a secret can never pass the gate unscanned while memory stays bounded; reported line numbers stay file-absolute and NUL windows still abandon binaries. Boundary-straddling and clean-large-file regression tests are in `scripts/check-secrets.test.ts`. Commit `32e7b7b`. |
| SEC-035 | P2 | Open, gated (publishing inactive) | The manual `release.yml` (`workflow_dispatch`) runs from the dispatched ref, so a maintainer who dispatches an attacker-supplied branch or ref could build and publish a malicious tarball with repository publish credentials. Publishing is human-gated and the `@eyeball` npm organization and `NPM_TOKEN` are unclaimed, so the path is inactive at launch. | Before the first publish, restrict dispatch to protected tags/refs and require provenance review of the dispatched ref; 0.5 day. |

M4.2 closes cross-feature audit ordinals 9–10 for observer durability and voice-worker transport classification. Those ordinal labels are not `SEC-009` or `SEC-010`; both security-register findings above remain open and unchanged.

## Secrets audit notes

- The delta-history scan covered every added and removed patch line in the exact
  38-commit main range and 10-commit cloud range. It searched for
  `ntn_`, `secret_`, Slack, OpenAI-style, GitHub, JWT, Google, AWS, and private-key
  shapes without printing candidate values. Main produced four false positives:
  two `push_secret_must_not_persist` references and two explicit webhook-secret
  non-persistence fixtures. Cloud produced 18 candidates across 15 lines, all
  `secret_*` encrypted-column names in generated migration snapshots. No token
  material was found.
- The two live-auth commits were inspected independently. The documented
  `.eyeball/vault.json` path is root-ignored and untracked; the local vault writes
  through an owner-only temporary file and chmods the final file to `0600`.
  SEC-023 closes the remaining argv/error-output footgun.
- No tracked real `.env` file was found in any of the three repositories; only
  documented `.env.example` templates are tracked. Repository ignore rules
  cover local environment files.
- Known key prefixes, entropy-like assignments, URL credentials, fixtures, and
  history for secret-adjacent files were reviewed. Matches were generators,
  explicit fake fixtures, schemas, or documentation.
- An older development-stack revision printed the configured development API
  key. The committed default was the deterministic local-only
  `eyeball_dev_project`, not a production credential. If an operator supplied a
  real key to that old revision, their historical local/CI logs need review and
  that key should be revoked. No history rewrite is warranted for the committed
  development value.
- The lightweight scanner intentionally favors low false positives and never
  prints the matched candidate. It is not a replacement for gitleaks, host-side
  secret detection, or provider-side key scanning.

## Dependency and supply-chain verdict

- The 2026-07-24 `pnpm audit --prod` attempts for main and cloud could not reach
  the npm advisory endpoint (`ENOTFOUND` / `fetch failed`). The required offline
  fallback found no new package records or lifecycle-script flags in main's lock
  delta: the added importer edges reuse already-locked Next/React,
  OpenTelemetry, Drizzle, PGlite, and `pg` packages. Cloud's lockfile did not
  change. The previously recorded online findings below therefore remain the
  advisory baseline; this review does not claim a fresh online clean audit.
- The four-package release build and `publish --dry-run --json` succeeded.
  Exact manifests contain 83 core, 223 catalog, 187 toolkits, and 23 SDK entries,
  limited to `dist`, source maps, `README.md`, `LICENSE.md`, and package
  manifests. Tests, fixtures, vault files, worker databases, signing keys, and
  grant values are absent. Public voice capability/driver code contains no grant
  signing secret.
- Current tracked-file secret scans pass in main, private cloud, and read-only
  Mockhouse. All current workflow actions remain pinned to full commit SHAs, and
  neither reviewed range changed workflow references.
- Main `pnpm audit` reached the registry and reported two High `expr-eval`
  advisories and one Low `@ai-sdk/provider-utils` advisory, all confined to the
  non-production Activepieces bridge and all without a published patched
  release. They are SEC-003 and SEC-009.
- Cloud and read-only Mockhouse `pnpm audit --audit-level=low` both reached the
  registry and reported no known vulnerabilities.
- The five Activepieces pieces and their explicit framework/shared compatibility
  dependencies are exact-pinned as required by RFC 003.
- GitHub Actions and the Mockhouse checkout use full commit SHAs.
- No first-party package defines `preinstall`, `install`, or `postinstall`.
  Installed dependency lifecycle scripts were limited to `esbuild`,
  `protobufjs`, and `sharp` in main; `esbuild` in cloud and Mockhouse. These
  names exactly match each repository's pnpm `allowBuilds` list.
- Native `pnpm licenses list` completed in all three repositories. Mockhouse is
  Apache/BSD/ISC/MIT-family only. Main's eight `Unknown` entries are the seven
  Activepieces packages in SEC-011 plus `spawndamnit`, whose installed `LICENSE`
  is MIT despite missing manifest metadata. Main also contains expected MPL and
  dynamically linked libvips LGPL entries. Cloud's sole `Unknown` is the local
  `@eyeball/core` package using `SEE LICENSE IN LICENSE.md` and the repository
  license file. A clean immutable release install must rerun and retain this
  report as evidence.
- Python direct and optional dependencies are exact-pinned. `uv pip check`
  verified all 34 installed packages are mutually compatible, but transitives
  are not hash-locked and `pip-audit` was unavailable, as recorded in SEC-010.

## Known architectural limitations

The following are explicit limitations, not implied guarantees:

- The stock rate limiter, toolkit concurrency limiter, trigger polling scheduler,
  and in-flight voice-observer task/timer handles are process-local. With
  Postgres, observer state is restart-reconciled and lease-fenced; without it,
  both observer state and voice webhook sources are process-local.
- With `EYEBALL_DATABASE_URL`, execution and webhook jobs use durable Postgres
  leases, deterministic identities, startup recovery, and private immutable
  webhook work snapshots. The zero-config queue remains in memory, and the
  Postgres worker has not been load- or chaos-certified as a managed service.
- With `EYEBALL_DATABASE_URL`, staged-file metadata and `bytea` content survive
  restart until TTL expiry. Without a database they remain process-local and are
  lost on restart. Logical expiry is enforced continuously on get/list, while
  bulk physical row reclamation drains 100-row batches at durable startup and
  deletes at most 100 rows per non-overlapping minute tick while the runtime is
  healthy, with lazy per-ID cleanup as well. Postgres insert failures are
  replaced at the `FileStore` boundary by a constant error with no retained
  driver message, parameters, or cause because Drizzle query errors can include
  bound `bytea` content.
- Postgres does not make trigger polling distributed. Polling still needs
  distributed leases, replay/backfill, provider signature verification, and an
  atomic claim/outbox. Redacted trigger-event history survives restart for seven
  days with Postgres and is process-local without it, but it cannot reconstruct
  provider payloads or signed webhook bodies. The dedup claim, webhook admission,
  and history append remain separate operations.
- With `EYEBALL_DATABASE_URL`, voice-agent definitions and immutable revisions,
  number bindings, executor-side session pointers, observer cursor/phase/retry
  state, complete voice webhook source envelopes, and message receipts are
  durable. Startup claims expired or unowned observers, resumes after the last
  durably handled sequence, reconciles terminal grant revocation, and rebuilds
  transcripts from complete worker history. Without a database those executor
  records remain process-local. Live worker session state/events remain
  worker-owned, and carrier/provider paths are not real-provider certified.
- With `EYEBALL_DATABASE_URL`, MCP negotiated-session and task records are
  durable and atomic; only a one-way binding over the inbound credential and
  configured project/pinned-user authority is stored, not either bearer or
  plaintext authority.
  After restart, the next correctly authenticated request supplies the downstream
  credential and rearms polling. Timer handles and SSE subscribers remain
  process-local, and stock SSE replay is not implemented. Executor cancellation is
  supported; once provider dispatch may have begun, cancellation remains best effort
  and external side effects may still complete even though late results are discarded.
- Staged files bind an optional owner user ID at upload; owned records enforce
  ownership on metadata and adapter byte resolution (SEC-017), while owner-less
  legacy/project-scoped uploads remain project-wide bearer capabilities.
- Provider-level idempotency propagation is separate from executor replay
  protection.
- The local vault is safe for one process, must not be shared between executors,
  detects ciphertext tampering, and does not detect rollback to an older valid
  vault file.
- Hosted OAuth, billing, and post-grace enforcement are implemented in the
  private cloud source, but production KMS/backup operations, live
  Stripe/provider validation, cloud deployment, license finalization, and
  real-provider certification are incomplete. Packages are preview source, not
  a claim of npm or hosted-cloud availability.
- Mockhouse includes documented shims where provider APIs lack canonical
  retrieval operations; passing mock contracts does not certify a real vendor.

## SOC 2 readiness gaps

| Control area | What exists | What is missing before readiness |
| --- | --- | --- |
| Logical access | Project/user authorization, cloud memberships and roles, reveal-once hashed API keys, session/CSRF controls. | Formal joiner/mover/leaver process, periodic access reviews, break-glass controls, SSO/MFA policy, and privileged-action approval. |
| Auditability | Structured redacted executor telemetry and tenant-scoped cloud audit events. | Central immutable retention, administrator/data-access events, clock/ingestion monitoring, alert coverage, review cadence, and evidence exports. |
| Key management | AES-GCM local/cloud vaults, versioned cloud KEK wrappers, reveal-once keys, secret rotation APIs for webhooks/triggers. | Documented custodians, KMS/HSM integration, rotation cadence/SLOs, automated KEK rewrap job, dual-control, inventory, expiry alerts, and completed rotation evidence. |
| Vulnerability management | Lockfiles, exact sensitive pins, SHA-pinned actions, offline secret scanner, this register. | Scheduled gitleaks/SCA/pip-audit/SBOM, advisory SLA, signed provenance, dependency update cadence, external penetration test, and remediation evidence. |
| Availability and recovery | Durable Postgres/PGlite records, lease-fenced execution/webhook/voice-observer work, startup recovery, conservative post-dispatch fencing, restart-durable staged-file metadata/`bytea` content until expiry, durable voice-agent resources/receipts/observer cursors/voice sources, and restart-durable MCP sessions/tasks. | Production backup schedule, storage monitoring and vacuum policy for potentially large `bytea` rows and lazily reclaimed MCP sessions, encryption/key escrow, restore drills covering staged files plus all voice-agent, observer, voice-source, and MCP session/task tables, RPO/RTO, regional/replica strategy, multi-replica load/chaos evidence, and dependency outage runbooks. |
| Incident response | [`INCIDENT-RESPONSE.md`](./INCIDENT-RESPONSE.md) skeleton and revocation order. | Named on-call/incident roles, paging and forensic tooling, tabletop exercise, counsel/insurer contacts, customer status channel, and postmortem evidence. |
| Change management | Pull-request CI, scoped tests, immutable action pins, release changesets. | Required review/branch protections evidence, production segregation of duties, deployment approvals, rollback evidence, and emergency-change procedure. |
| Vendor and data governance | Provider manifests and a partial license/provenance review. | Vendor risk register, subprocessors, DPAs, data-flow inventory, retention/deletion policy, data classification, privacy request process, and license sign-off. |
| Secure development | Strict TypeScript, schema validation, redaction seams, regression tests, threat models. | Annual training, secure-design checklist, mandatory threat-model updates, SAST policy, fuzzing for parsers/proxies, and independent review. |

## Vulnerability disclosure

Until a public security contact is provisioned, **`security@eyeball.dev` is a
placeholder and must not be represented as monitored**. Before any public
release, publish and monitor that mailbox (or replace it here), add a
`SECURITY.md` contact to public hosting, and define an encrypted intake path.

Reports should include the affected version/commit, reproduction steps, impact,
and any proof-of-concept data. Reporters should avoid accessing other users'
data, disrupting service, or publishing details before coordinated disclosure.
Eyeball's target acknowledgement is one business day for critical reports and
three business days for other reports; the disclosure timing policy is in
[`INCIDENT-RESPONSE.md`](./INCIDENT-RESPONSE.md).

## RELEASE-SECURITY-VERDICT

### OSS npm publication

**Blocking findings:** No code-level security blocker was found in the four
public tarballs. SEC-002 and SEC-017 are hosted-service boundaries; SEC-003 and
SEC-009 remain confined to the excluded private Activepieces spike; SEC-010 is
the separately deployed Python worker. Before publication, the placeholder
security contact must be provisioned and tested, and the already-recorded final
license/provenance sign-off must complete.

**Accepted-risk items:** Published source maps disclose the package source
layout by design. The npm packages expose public voice contracts and remote
session-driver code, but contain no signing key, live capability, fixture
credential, worker database, or private cloud source. The fresh online advisory
query was unavailable, so the unchanged lockfile/advisory baseline and exact
tarball inspection are the evidence for this decision.

**Verdict — conditional go.** From the reviewed code and package contents, OSS
npm publication can proceed after the monitored disclosure channel and final
license/provenance sign-off are in place. Those are real release prerequisites,
but this delta review found no reason to hold the four public packages for an
additional code-security fix.

### Hosted cloud launch

**Blocking findings:** SEC-002 (DNS-rebinding SSRF at webhook delivery) and
SEC-017 (same-project cross-user staged-file capability) remain explicit hosted
launch gates. SEC-008 blocks exposure of Slack push ingest unless that feature is
disabled or provider-native signatures are added. Production key custody,
backup/restore evidence, and rotation operations under CLOUD-005 also remain
unproven.

**Accepted-risk items:** Shared internal bearers remain replayable
(SEC-006/CLOUD-003), database RLS is absent (CLOUD-004), audit retention is not
yet immutable (CLOUD-006), and worker-independent replay after theft remains
possible during a grant's short lifetime (SEC-025). These are defensible only
inside the documented private-network, least-privilege, one-worker-per-trust
boundary with upstream log suppression and active monitoring; they are not
claims of Internet-scale certification.

**Verdict — wait.** Do not launch the current source as a general public
multi-tenant hosted service. The delta materially improved usage atomicity,
delinquency enforcement, durability, cancellation, readiness, and voice
capability scope, but the SSRF and staged-file isolation gates are still
concrete cross-boundary risks, and production key/backup operations are not yet
evidenced. A limited preview is reasonable only if webhooks, push ingest, and
multi-user file sharing are feature-gated and the documented infrastructure
controls are actually enforced.
