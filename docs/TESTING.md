# Eyeball Testing Strategy

- Status: implemented for the 0.2.0 source release
- Scope: `packages/core`, `packages/sdk`, `packages/bridge`, `apps/executor`, `apps/voice-worker`, `apps/mcp-gateway`, and the separate
  `eyeball-mocks` repository
- Primary runner: Vitest for TypeScript suites; scripted clients for protocol-level E2E

This document defines how Eyeball proves that canonical tools behave consistently across providers and delivery
surfaces. The center of gravity is contract testing through the real executor and adapters, with deterministic
provider APIs supplied by `eyeball-mocks`.

The normative execution behavior and closed error taxonomy come from [RFC 001 §§3–4](./rfcs/001-canonical-tools.md#3-execution-api); voice and trigger additions come from [RFC 002](./rfcs/002-voice-agents.md) and [RFC 004](./rfcs/004-triggers.md).
Mock behavior, fixtures, and the real-auth swap are owned by [MOCKS.md](./MOCKS.md); this document references rather
than redefines them.

## 1. Test pyramid

The pyramid describes confidence and frequency, not just test count. Integration and mock-target contracts are the
largest layer because most risk sits between schemas, credential resolution, adapters, providers, and executions.

| Layer | Primary scope | Frequency | Required dependencies |
|---|---|---|---|
| Unit | Pure core, SDK, and adapter helpers | Every push | Process-local only |
| Integration | Executor plus toolkit adapters | Every pull request | In-process `eyeball-mocks` |
| Contract | Canonical capability suites by provider and target | Mock on every pull request | Manifests plus selected target |
| E2E | MCP client and agent loops through the gateway | Nightly | Mocks; optional LLM API |
| Real-target certification | Current vendor compatibility | Manual and pre-launch | Vendor sandbox credentials |

### 1.1 Unit tests

Unit tests give fast, exhaustive feedback for deterministic logic. `packages/core` is the main focus:

- Validate every canonical input/output schema across defaults, optional fields, refinements, unions, boundaries, and unknown keys.
- Prove converter bundles preserve exact canonical schemas, reversible names, and immutable sidecars; reject a target
  schema incompatibility instead of accepting a lossy fallback.
- Map provider failures into every RFC 001 code; assert retryability/delay, safe metadata, and redaction independently.
- Exercise deterministic JSON ordering and request hashing used by idempotency.
- Test manifest parsing, capability membership, and qualified tool resolution.

Pure helpers in `packages/sdk` and `packages/bridge` also belong here. Adapter mappers may have focused tests for
provider envelopes, but unit coverage never substitutes for running the adapter through the executor.

Prefer table-driven and property-based schema/converter cases. Round-trip properties assert canonical name identity and
that every field omitted by a native descriptor remains unchanged in the immutable sidecar.

### 1.2 Integration tests

Integration tests are the bulk of the suite. They start the executor with production catalog, schema, credential,
persistence, and adapter code, then point provider base URLs at `eyeball-mocks`.

Each test should cross as many real boundaries as practical:

1. Send a canonical `ExecuteRequest` to `POST /v1/execute`.
2. Resolve the pinned catalog definition and validate canonical input.
3. Select credentials through `MockCredentialProvider`.
4. Invoke the production toolkit adapter against a mock provider route.
5. Normalize failures or validate successful canonical output.
6. Persist and retrieve the resulting execution.

Integration coverage includes sync success/failure, async polling, idempotency replay/conflict, connection selection,
output-schema rejection, and terminal webhooks. Assertions observe Eyeball APIs, execution storage, and safe logs—not
mock store internals.

Mock startup, seeding, isolation, clock control, and fixtures follow [MOCKS.md §§3, 8–9](./MOCKS.md#3-architecture).
Tests consume its mock-kit API instead of creating another harness here.

### 1.3 Contract tests

Contract tests are reusable capability specifications. Every case is parameterized by `{ provider, target: "mock" |
"real" }` and executes canonical tools through the executor. Both forms share request builders, bodies, and assertions
under the [real-auth swap contract](./MOCKS.md#10-real-auth-swap-contract).

Mock contracts run continuously; real contracts are opt-in. Only base URL, credential provider, tenant-safe setup, and
cleanup vary by target.

### 1.4 End-to-end tests

E2E starts `apps/executor` and `apps/mcp-gateway`, exposes canonical tools through MCP, and drives mocks two ways:

- A scripted MCP client lists and invokes tools, polls when needed, and checks MCP content plus the stored execution.
- A real LLM agent discovers canonical tools, supplies fixture-grounded arguments, handles results, and completes a
  bounded task.

The scripted client is the protocol gate and fallback when no LLM key is configured. The agent loop detects description,
schema, selection, and multi-step regressions, but its nondeterminism does not block pull requests.

The deterministic MCP episode discovers and executes Gmail, GitHub, and Slack in sequence and asserts provider state plus
the three stored child executions. A Messages-compatible fixture client continuously tests restricted-name mapping and
tool-result continuation; setting `ANTHROPIC_API_KEY` additionally enables the bounded live Anthropic episode, which is
skipped in normal CI.

The deterministic voice episode creates an immutable restaurant-agent revision, starts a scripted Pipecat caller, runs two
model turns, and dispatches Calendar and Gmail through the ordinary executor. It asserts pinned project/user scope, the
revision allowlist, stable event-derived idempotency, exact `exe_*` identity across `tool_call`, `tool_result`, transcript,
and execution storage, plus final provider side effects. Pipecat time advances through the injected mock clock.

E2E scenarios use mock providers. They prove the complete Eyeball path, not live vendor reachability.

### 1.5 Real-target certification

Real-target tests run the same applicable contracts against dedicated vendor tenants. They are manual, credential-gated,
isolated from mock CI, and required for launch certification. They cover current wire compatibility, policy, and scopes.

## 2. Contract suite design

### 2.1 Canonical capability suites

There is one suite per catalog capability: email, calendar/scheduling, messaging/chat, voice/telephony, SMS, CRM,
ERP/accounting, social data, social publishing, files/docs, spreadsheets/databases, project/dev, payments/billing,
e-commerce, support, web search/scraping, HR/recruiting, marketing/ads, sign/forms, and AI/media. Catalog 1.1
`voice-agents` tools extend the existing voice/telephony suite.

Suites use canonical tool names and schemas. They do not import provider SDK types, send provider payloads, branch on
vendor text, or treat provider HTTP status as the product result. Provider setup stays outside the contract body.

A capability suite owns:

- Canonical request builders with isolated data and output-schema/semantic assertions.
- Stateful create/read/update/list/delete scenarios where applicable.
- Shared taxonomy errors plus capability-specific async or event assertions.
- Cleanup declarations for resources created on a real target.

### 2.2 Manifest-derived provider matrix

Provider manifests are the sole source of implemented-tool membership. The runner expands each capability into one row
per provider and canonical tool:

| Manifest state | Contract expectation |
|---|---|
| Tool declared | Run the tool's success and applicable error scenarios |
| Tool omitted | Execute the canonical request and expect `not_supported` |
| Unknown tool declared | Fail matrix generation before tests run |
| Canonical tool has no contract case | Fail suite completeness before tests run |

The matrix records provider, capability, tool, manifest/suite versions, target, outcome, and quirk. CI publishes it and
uses the same expansion for both targets.

This prevents invented full-capability support and untested advertised tools. Capability suites cannot contain manual
provider lists.

### 2.3 Shared execution assertions

All suites reuse RFC 001 execution assertions:

- Sync success is HTTP 200 with canonical output/latency; sync tool failure is an allocated `failed` execution without output.
- Async is HTTP 202 with one initially `pending` execution; polling is monotonic and terminal records are immutable.
- Invalid input rejected before allocation uses an error envelope without an execution identity.
- Sync use of async-only tools is pre-allocation `invalid_input`.
- Mutations require idempotency: identical replay returns the same execution; a changed request returns `invalid_input`.
- Successful adapter output must pass the canonical output schema.
- Invalid adapter output is non-retryable `provider_error`, never success.
- Connection ambiguity and cross-user/project mismatch do not disclose existence.
- Provider details and logs contain no credential, cookie, authorization header, or unrelated data.

### 2.4 Shared error-taxonomy assertions

The taxonomy helper asserts `code`, retryability/delay, safe provider metadata, allocation semantics, and no secrets.
Mock scenarios use [MOCKS.md §5.3](./MOCKS.md#53-trigger-tokens-and-error-shapes), including:

| Scenario input | Required normalized result |
|---|---|
| `fixture:EXPIRED_TOKEN` | `auth_expired`, not retryable |
| `fixture:INSUFFICIENT_SCOPE_TOKEN` | `auth_insufficient_scope`, not retryable |
| `fixture:RATE_LIMITED_TOKEN` | `rate_limited`, retryable, preserve safe retry metadata |
| Missing provider object | `not_found`, not retryable |
| Scripted provider outage | `provider_unavailable`, retryable |
| Invalid provider success payload | `provider_error`, not retryable |
| Deadline before an unprotected side effect | `timeout`, retryability asserted from safety |
| Manifest omission | `not_supported`, not retryable |

The helper never accepts provider text in place of an RFC code. Real setup may create the condition differently, but the
canonical request and normalized assertion do not change.

### 2.5 Parameterized runner sketch

This is illustrative harness shape, not a replacement for `MOCKS.md`:
`contract.request` may accept toolkit context to qualify the canonical name, but it MUST
return exactly RFC 001's `{ tool, userId, connectionId?, input, mode }` body; `toolkit` and
`projectId` are not request fields.

```ts
type TargetKind = "mock" | "real";
type CapabilityOptions = {
  providers: readonly ProviderCase[];
  target: TargetKind;
};
export function describeCapability(capability: Capability, options: CapabilityOptions) {
  describe(`${capability} [${options.target}]`, () => {
    for (const provider of options.providers) {
      const runtime = resolveContractTarget(provider, options.target);
      describe(provider.slug, () => {
        for (const tool of capabilityTools(capability)) {
          const contract = loadCanonicalContractCase(capability, tool.name);
          const declared = provider.manifest.implements.some(
            (implementation) =>
              implementation.capability === capability &&
              implementation.canonicalTool === tool.name,
          );
          it(`${tool.name}: ${declared ? "conforms" : "not supported"}`, () =>
            runtime.withContext(contract, async (context) => {
              const request: ExecuteRequest = contract.request({
                toolkit: provider.manifest.toolkit.slug,
                userId: context.userId,
              });
              const result = await context.executor.execute(request);
              if (!declared) return assertToolError(result, { code: "not_supported", retryable: false });
              contract.assertSuccess(result);
              await contract.assertState?.(context, result);
            }),
          );
        }
        describeSharedErrorTaxonomy({ capability, provider, target: runtime });
      });
    }
  });
}
describeCapability("email", {
  providers: providersForCapability(loadProviderManifests(), "email"),
  target: contractTargetFromEnvironment(),
});
```

The runner builds a fresh context per case or uses worker-isolated mocks. Review rejects target-dependent assertions;
only setup and cleanup may vary.
For every mutating row, the runtime also attaches a deterministic RFC 001 `Idempotency-Key`
outside the `ExecuteRequest` body and reuses that key for the case's replay assertions.

## 3. Async and voice testing

### 3.1 Async executions and polling

Async tests use the `eyeball-mocks` clock and never sleep for provider progress. The standard scenario is:

1. Seed the named async scenario and capture its initial simulated time.
2. Execute canonically; assert HTTP 202, `pending`, and one execution identity.
3. Poll, advance the clock to each boundary, and assert the scripted monotonic state/timestamps.
4. Assert terminal output or normalized error, latency, and immutable terminal state.
5. Replay the idempotency key; confirm no second provider job or execution was allocated.

Require success, provider failure, timeout-before-side-effect, and retry/idempotency cases. Tests may wait for executor
work to drain, but only clock advance drives provider progress; arbitrary timeouts are not synchronization.

### 3.2 Voice sessions and scripted callers

Voice follows RFC 002, [MOCKS.md §4.3](./MOCKS.md#43-l3-interactive-fidelity), and
[MOCKS.md §8.2](./MOCKS.md#82-fixtures). Catalog 1.0 provider cases
remain pinned to 1.0; `voice-agents` resource and tool cases pin catalog 1.1. Tests compose the production voice runtime,
executor, provider mocks, and committed caller scripts. Routine CI uses the text fast path.

Cover happy path, barge-in, DTMF, hangup, silence, provider failure, unexpected tools, and new
plus continued chat turns. Assert:

- Session states through the correct terminal state and strictly ordered lifecycle, transcript,
  tool, handoff, and DTMF events; hangup is asserted through its resulting lifecycle transition.
- Stable correlation among call, session, execution, and transcript artifacts.
- Only scenario-allowed prompts/actions, with mid-call tools in normal execution logs and invocation order.
- Every child execution uses the initiating `userId` and permitted connection scope.
- One user's queries never expose another user's child executions or correlated payloads.
- Child failures are normalized in both the event stream and execution log.
- Barge-in cancels or supersedes the correct turn without reordering committed events.
- Terminal events and execution records stay immutable after further clock advances.
- Each `send_session_message` execution becomes terminal when its one assistant turn is durable
  without terminalizing the chat session; pinned-revision mismatch, `clientMessageId` replay,
  and changed-content conflict follow RFC 002.

Voice tests do not bypass allowlists, add test-only definition fields, or call provider routes directly. Fixture scripts
and mock behavior stay in `eyeball-mocks`.

### 3.3 Durable remote-observer matrix

Remote-observer tests run the same state machine against memory and PGlite stores and treat the
worker's durable ordered log as authoritative. The normative matrix requires:

- a cursor acknowledgement boundary proving source persistence, webhook work admission, and
  terminal grant handling finish before `handled_sequence` advances;
- expected-cursor and lease-token fencing, one winning claimant, healthy-lease protection, expired
  takeover, and rejection of stale-owner checkpoints;
- restart with the same PGlite `dataDir`: runtime A persists sequence `N`, runtime B's first normal
  event read uses `afterSequence=N`, and its separate transcript-finalization read starts at zero;
- source/work/delivery identity reuse under replay, durable envelope reconstruction by a new
  `WebhookDeliverer`, and a recoverable invariant path for legacy work missing a voice source;
- a session becoming terminal during downtime, idempotent grant revocation, and a final transcript
  containing turns from both before and after restart;
- finalization failures consuming the same persisted retry ceiling, 20 transient failures producing
  one exhausted record/log/failure webhook, immediate exhaustion for invalid responses, and later
  recovery of an exhausted-but-unsignaled row;
- driver taxonomy cases for reachability failure, 5xx/429, request timeout/408, malformed or
  version-incompatible payloads, non-transient 4xx, and caller cancellation, with exact canonical
  code and retryability assertions; and
- secret-absence assertions over driver errors and serialized telemetry: no control token, worker
  URL, authorization header, grant material, webhook URL/secret, transcript, raw response body, or
  provider payload may appear.

## 4. CI layout

GitHub Actions separates deterministic gates from credentialed or nondeterministic checks.

| Job | Trigger | Contents | Network policy |
|---|---|---|---|
| `quality` | Every push and pull request | Format, lint, typecheck | Egress only for checkout/install |
| `unit` | Every push and pull request | Core, SDK, bridge, adapter helper units | No egress while tests run |
| `integration-mock` | Every pull request | Executor plus adapters against in-process mocks | Loopback only |
| `contract-mock` | Every pull request | All manifest-derived capability rows, target `mock` | Loopback only |
| `e2e-nightly` | Nightly schedule and manual | Scripted MCP client; optional real-LLM agent loop | Mocks plus optional LLM endpoint |
| `contract-real-<batch>` | Manual dispatch | Selected providers, target `real` | Allowlisted vendor endpoints |

### 4.1 Push and pull-request gates

`quality` and `unit` start first and may shard by workspace. Pull requests then run integration and mock contracts with
a pinned, in-process `eyeball-mocks`. Results attach fixture, mock, suite, and catalog versions plus simulated start time.

After install, mock jobs run with outbound network disabled; executor, gateway, and mocks share the sandbox so loopback
works. An HTTP/DNS guard fails on any non-loopback destination. Accidental egress is not retried.

### 4.2 Nightly E2E

Nightly always runs the scripted MCP client. With an LLM key, it also runs bounded agent-loop cases. That key and its
allowlisted endpoint are the only external dependency; adapters still target mocks and other egress stays denied.

Without the key, record the LLM portion as `not_run` and complete the scripted fallback. LLM cases use fixed prompts,
bounded turns/tool budgets, fixture-grounded outcomes, and sanitized transcripts; selection failures are reported
separately from contract failures.

### 4.3 Real-target workflows

Real contracts use `workflow_dispatch` with provider and suite version. Keep one workflow per credential/endpoint batch
(email/productivity, messaging, voice, business, social, web) so jobs receive only their secrets.

GitHub Environments add approval, concurrency limits, and audit logs. Each job uses a dedicated tenant, unique prefix,
strict cleanup, bounded requests, and endpoint allowlist. Retain results and sanitized diagnostics, never authorization.

Real failures do not auto-retry side effects. A retry reuses its idempotency key or follows explicit state inspection.

## 5. Real-auth certification process

Certification follows green adapter/mock conformance and the swap boundary in
[MOCKS.md §10](./MOCKS.md#10-real-auth-swap-contract). The exact credential variables, provider batches, app setup,
commands, evidence checks, and manual workflow are maintained in [REAL-AUTH.md](./REAL-AUTH.md).

For each provider:

1. Provision a dedicated vendor tenant with minimum scopes.
2. Add approved real `CredentialProvider` configuration and environment-secret mapping.
3. Select the vendor URL without changing canonical requests, adapter code, or assertions.
4. Run the manifest-derived suite with `target=real` and a pinned suite version.
5. Inspect failures, clean up, retain sanitized evidence, and update `docs/CERTIFICATION.md`.
6. Set `launch-certified` only when applicable mock and real rows are green.

The certification matrix has this minimum shape:

| Provider | Suite version | Date | Pass/fail | Quirks |
|---|---|---|---|---|
| `provider-slug` | Contract package or commit | `YYYY-MM-DD` | pass/fail | Quirk IDs or `none` |

Also link the run, manifest/mock versions, exposed vendor API version, and cleanup status—never credentials or customer data.

### 5.1 Flakiness and vendor drift

A real failure is evidence to investigate, not something to average away:

- Re-run only after classifying transport, tenant state, quota, credentials, adapter defect, drift, or cleanup.
- Open or update a quirk entry with sanitized observed behavior, scope, and reproduction date.
- Block certification for contract-breaking quirks; do not weaken canonical assertions per target.
- Update the adapter when normalization or wire compatibility is wrong.
- Update mocks/fixtures only from observed, sanitized real behavior.
- Add a regression contract before closing the quirk.
- Record a new passing certification run after every corrective change.

Real runs correct mock drift; vendor behavior is not guessed. Deterministic mock failures are never flaky and block merge.

## 6. Quality gates

### 6.1 Coverage expectations

Coverage is risk-based and ratcheted:

- `packages/core`: at least 90% statements/lines/functions and 85% branches, with no changed-module regression.
- Schema validation, error mapping, redaction, and converters require positive, negative, and boundary cases.
- Adapters are measured by contract rows, not line percentage.
- Every declared tool needs mock success/applicable error rows; every omitted tool needs a `not_supported` row.
- Keep sync/async, allocation/terminal failure, output validation, idempotency, credential selection, and user scoping
  integration-covered.
- MCP gateway tool discovery and invocation must remain scripted-E2E covered.
- Scripted MCP assertions keep canonical output in `structuredContent` and require allocated
  terminal results to expose RFC 001's `dev.eyeball/execution` metadata without adding those
  fields to the canonical output schema.

Coverage cannot compensate for a missing manifest row, unasserted canonical output, or skipped error mapping.

### 6.2 No-network-egress gate

After install, unit and mock-target tests block external DNS/HTTP and permit only loopback. Attempted egress reports the
test and destination. Mocks boot in-process per [MOCKS.md §9](./MOCKS.md#9-test-harness-integration).

Only nightly LLM and manual real jobs are exceptions; their allowlists are explicit and job-scoped.

### 6.3 Pull-request checklist

Every provider addition or surface expansion includes:

- [ ] A manifest declaring only the implemented subset and an adapter using canonical inputs/outputs.
- [ ] A provider mock at the required fidelity plus versioned, deterministic, safe fixtures.
- [ ] Generated rows for every capability tool: success when declared, `not_supported` when omitted.
- [ ] Shared error/redaction cases plus integration through the executor, not only adapter units.
- [ ] Annotation-required async/event/polling/idempotency coverage.
- [ ] Documented cleanup/real prerequisites and a passing no-egress mock contract run.

Canonical schema/capability changes require suite-version review, regenerated matrices, converter checks, and stated
certification impact. Mock evidence alone never grants launch certification.
