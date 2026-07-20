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

## Threat model

### Assets

- Project API keys and user-pinned API keys.
- Provider API keys, OAuth access/refresh tokens, and connection metadata.
- Local-vault encryption keys and cloud key-encryption keys (KEKs).
- Execution inputs, outputs, staged files, identities, and audit records.
- Webhook signing secrets and trigger-ingest secrets.
- Voice-worker control tokens, executor keys, media tokens, transcripts, and
  call metadata.
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
  +---------- user-pinned voice-worker key + reserved child IDs
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
| Executor logs and telemetry redact credential fields, authorization headers, canonical bodies, file bytes, URLs, and nested secrets before emission. | Central wrapper in `apps/executor/src/telemetry/log.ts`; [`apps/executor/test/telemetry.test.ts`](../apps/executor/test/telemetry.test.ts). |
| Provider errors retain bounded diagnostics without exposing response secrets or configured credential values, and credentialed redirects are not followed. | `packages/toolkits/src/http-client.ts`; [`apps/executor/test/http-client.test.ts`](../apps/executor/test/http-client.test.ts). |
| Cloud audit metadata passes through recursive named-field redaction before persistence. | `cloud/apps/control/src/audit.ts`; [`cloud/apps/control/test/control.test.ts`](../cloud/apps/control/test/control.test.ts) and [`cloud/apps/control/test/vault.test.ts`](../cloud/apps/control/test/vault.test.ts). |
| The local vault encrypts every credential with AES-256-GCM, authenticates record metadata as AAD, and rejects ciphertext/AAD tampering. | `packages/core/src/local-vault.ts`; [`packages/core/test/local-vault.test.ts`](../packages/core/test/local-vault.test.ts). |
| Cloud credentials use per-record AES-256-GCM data keys wrapped by a versioned KEK; keys can be rewrapped without re-encrypting payloads. | `cloud/apps/control/src/vault/crypto.ts` and `vault/service.ts`; [`cloud/apps/control/test/vault.test.ts`](../cloud/apps/control/test/vault.test.ts). |
| Public API keys are reveal-once and cloud persistence contains only SHA-256 hashes; password records use scrypt. | `cloud/apps/control/src/app.ts`; [`cloud/apps/control/test/control.test.ts`](../cloud/apps/control/test/control.test.ts). |
| Outbound execution webhooks sign `<unix-seconds>.<raw-body>` with HMAC-SHA256 and expose the signature as `v1=<hex>`. Verification has a five-minute replay window. | `packages/core/src/webhooks.ts`; [`packages/core/test/webhooks.test.ts`](../packages/core/test/webhooks.test.ts). |
| Trigger-ingest secrets are 32 random bytes, stored only as SHA-256 hashes, compared in constant time, returned only in create/rotate URLs, and immediately invalidated on rotation. | `apps/executor/src/triggers/service.ts`; [`apps/executor/test/triggers.test.ts`](../apps/executor/test/triggers.test.ts). |
| A user-pinned key cannot assert a different user or read another user's executions, connections, webhooks, or triggers. | Executor authorization in `apps/executor/src/routes.ts`; [`apps/executor/test/execution.test.ts`](../apps/executor/test/execution.test.ts) and [`apps/executor/test/triggers.test.ts`](../apps/executor/test/triggers.test.ts). Staged-file ownership is a separately documented gap. |
| Caller-supplied reserved child execution IDs require a user-pinned key, synchronous mode, and an idempotency key. | `apps/executor/src/routes.ts`; [`apps/executor/test/execution.test.ts`](../apps/executor/test/execution.test.ts). |
| The dashboard forwards only allowlisted cloud cookies/headers and stores executor keys in project-scoped HttpOnly, SameSite=Strict cookies. Cloud and executor redirects are not followed. | `apps/dashboard/src/lib/cloud-proxy.ts` and `executor-proxy.ts`; [`apps/dashboard/src/lib/cloud-proxy.test.ts`](../apps/dashboard/src/lib/cloud-proxy.test.ts) and [`apps/dashboard/src/lib/executor-key-route.test.ts`](../apps/dashboard/src/lib/executor-key-route.test.ts). |
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
cloud cookies. The executor proxy exposes only `/health` and `/v1/*`, constructs
its upstream URL, forwards a fixed header set, reads only the selected project's
server-side key cookie, strips upstream redirects, and never forwards the
browser cookie header.

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

Staged-file records are currently scoped only to a project, not to their
uploading user. File IDs are high-entropy and expire after one hour by default,
but a pinned user who obtains another same-project user's file ID can retrieve
its metadata or reference its bytes in an execution. Treat file IDs as bearer
capabilities until user ownership is enforced in the file-store contract. The
JSON upload route applies a streaming body ceiling derived from the configured
decoded-byte limit plus 16 KiB for metadata before parsing or base64 decoding.

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
and IPv4-mapped addresses. Delivery does not follow redirects. Hostnames are not
resolved and pinned at registration or delivery, however, so DNS rebinding and
time-of-check/time-of-use changes remain open. Production must also enforce a
network-layer egress deny policy.

### Voice worker

The worker control API uses one high-entropy service token and versioned,
session-addressed routes. Stable child execution identities re-enter the normal
executor through a user-pinned API key. The default self-host model is one
worker per trusted pinned user; the single control token is not a multi-tenant
session capability. Media URL tokens are session-derived but still travel in a
query; Uvicorn access logging is disabled and upstream access logs must follow
the same rule.

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
| SEC-002 | P1 | Open, launch gate | Webhook registration blocks literal private addresses but does not resolve and pin DNS at delivery, leaving DNS-rebinding/TOCTOU SSRF. | Resolver-aware delivery with IP classification on every connection, address pinning, and network egress policy; 3–5 days. |
| SEC-003 | P1 | Open, bridge gate | `@activepieces/shared` brings unpatched `expr-eval@2.0.2`; [GHSA-8gw3-rxh4-v6jx](https://github.com/advisories/GHSA-8gw3-rxh4-v6jx) and [GHSA-jc85-fpwf-qm7x](https://github.com/advisories/GHSA-jc85-fpwf-qm7x) permit prototype pollution/code execution when attackers control expressions or evaluation variables. The bridge remains a private spike and must not accept untrusted formulas. | Replace with a maintained compatible fork and run formula compatibility/security tests, or remove formula evaluation; 1–2 days. No patched `expr-eval` release exists. |
| SEC-004 | P1 | Open, hosted-voice gate | One voice-worker bearer token authorizes every session on that worker. This is acceptable only for the documented single-user/service boundary. | Issue short-lived, audience- and session-scoped capabilities or isolate workers per tenant; 3–5 days. |
| SEC-005 | P1 | Open, product decision | After the 14-day cloud billing grace period, existing keys and connections continue executing indefinitely; only creation is blocked. A delinquent tenant can continue incurring provider/control-plane cost. | Define suspension semantics and enforce them at execution/credential resolution, with operator override and tests; 1–2 days. |
| SEC-017 | P1 | Open, hosted multi-user gate | Staged files are project-scoped rather than user-owned. A pinned user who learns another same-project user's high-entropy file ID during its TTL can retrieve metadata or reference those bytes in an execution. | Add owner user IDs to the file contract/store, bind uploads to the effective identity, and enforce ownership on metadata and adapter resolution; 1–2 days including persistence migration and tests. |
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

## Secrets audit notes

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

- The stock rate limiter, concurrency limiter, asynchronous task queue, webhook
  retry queue, and parts of remote voice-event observation are process-local.
- Postgres makes execution/idempotency, webhooks, and triggers durable, but does
  not make process-local schedulers distributed. Trigger polling still needs
  leases, replay/backfill, provider signature verification, and an atomic
  claim/outbox.
- Voice agent definitions/bindings and executor-side session pointers remain
  process-local. Live carrier/provider paths are not real-provider certified.
- MCP sessions and task pollers are process-local; stock SSE replay and executor
  cancellation are not implemented.
- Staged files are project-scoped bearer capabilities, not user-owned records,
  until SEC-017 is remediated.
- Provider-level idempotency propagation is separate from executor replay
  protection.
- The local vault is safe for one process, must not be shared between executors,
  detects ciphertext tampering, and does not detect rollback to an older valid
  vault file.
- Hosted OAuth and billing are implemented in the private cloud source, but
  production KMS/backup operations, live Stripe/provider validation, delinquency
  enforcement policy, cloud deployment, license finalization, and real-provider
  certification are incomplete. Packages are preview source, not a claim of npm
  or hosted-cloud availability.
- Mockhouse includes documented shims where provider APIs lack canonical
  retrieval operations; passing mock contracts does not certify a real vendor.

## SOC 2 readiness gaps

| Control area | What exists | What is missing before readiness |
| --- | --- | --- |
| Logical access | Project/user authorization, cloud memberships and roles, reveal-once hashed API keys, session/CSRF controls. | Formal joiner/mover/leaver process, periodic access reviews, break-glass controls, SSO/MFA policy, and privileged-action approval. |
| Auditability | Structured redacted executor telemetry and tenant-scoped cloud audit events. | Central immutable retention, administrator/data-access events, clock/ingestion monitoring, alert coverage, review cadence, and evidence exports. |
| Key management | AES-GCM local/cloud vaults, versioned cloud KEK wrappers, reveal-once keys, secret rotation APIs for webhooks/triggers. | Documented custodians, KMS/HSM integration, rotation cadence/SLOs, automated KEK rewrap job, dual-control, inventory, expiry alerts, and completed rotation evidence. |
| Vulnerability management | Lockfiles, exact sensitive pins, SHA-pinned actions, offline secret scanner, this register. | Scheduled gitleaks/SCA/pip-audit/SBOM, advisory SLA, signed provenance, dependency update cadence, external penetration test, and remediation evidence. |
| Availability and recovery | Durable Postgres/PGlite store implementations and encrypted records. | Production backup schedule, encryption/key escrow, restore drills, RPO/RTO, regional/replica strategy, queue recovery, and dependency outage runbooks. |
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
