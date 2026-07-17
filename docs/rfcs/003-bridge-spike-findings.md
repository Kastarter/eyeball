# RFC 003: Activepieces Bridge Spike Findings

- Status: Completed experiment; not approved for production rollout
- Date: 2026-07-17
- Applies to: `packages/bridge`
- Contract authority: subordinate to RFC 001 and `docs/PROVIDERS.md`

## 1. Decision

The five-piece spike supports a **selective, per-piece bridge**, not a generic claim that
all Activepieces pieces can run inside Eyeball.

`packages/bridge` remains private and experimental. Do not add its generated definitions
or adapters to the catalog yet, do not run pieces in the ordinary executor process, and do
not claim automatic compatibility with the wider Activepieces catalog.

The source strategy is:

1. Do not vendor the Activepieces monorepo or all community pieces.
2. During evaluation, consume exact npm versions with lockfile integrity.
3. Promote one piece at a time after recording its upstream source commit and license,
   defining explicit canonical mappings, and passing mock and real-provider certification.
4. Vendor a minimal audited source snapshot or maintain a small patch fork only when that
   promoted piece requires a transport, context, or security patch that upstream does not
   provide. Preserve the upstream license notice in any redistribution.

This keeps upstream updates visible and avoids taking ownership of unrelated workflow-engine
code while still giving Eyeball a controlled escape hatch for pieces whose bundled clients
cannot satisfy the executor boundary.

## 2. Spike inputs

All package versions are exact pins in `packages/bridge/package.json` and `pnpm-lock.yaml`.

| Piece | Version | Auth declarations | Actions | Triggers | Declared props | `DYNAMIC` props |
|---|---:|---|---:|---:|---:|---:|
| Gmail | `0.12.8` | OAuth2; custom service account | 7 | 4 | 71 | 2 |
| Airtable | `0.6.10` | secret-text personal access token | 15 | 2 | 64 | 5 |
| Slack | `0.17.3` | OAuth2; custom bot/user tokens | 28 | 14 | 147 | 2 |
| Discord | `0.5.4` | secret-text bot token | 16 | 2 | 58 | 2 |
| Typeform | `0.4.6` | OAuth2 | 1 | 1 | 11 | 2 |
| **Total** |  |  | **67** | **23** | **351** | **13** |

The imports expose context version `2`. The trigger inventory contains 14 app-webhook,
eight polling, and one webhook trigger. The spike introspects triggers but deliberately does
not execute or register them.

The five bundles exercise 14 property kinds: `ARRAY`, `CHECKBOX`, `DATE_TIME`, `DROPDOWN`,
`DYNAMIC`, `FILE`, `JSON`, `LONG_TEXT`, `MARKDOWN`, `MULTI_SELECT_DROPDOWN`, `NUMBER`,
`OBJECT`, `SHORT_TEXT`, and `STATIC_DROPDOWN`.

Run the deterministic inventory after building the package:

```sh
pnpm --filter @eyeball/bridge introspect
```

## 3. What the spike implements

The experimental package provides:

- structural introspection over real piece, action, trigger, auth, and property objects;
- a Draft 2020-12 property transformer with closed action objects and strict-core validation;
- connection-time hydration for a real Airtable `DYNAMIC` fields property;
- `ResolvedCredential` mapping for OAuth2, secret-text/custom API keys, basic auth, and no-auth;
- a minimal action context and process-local store;
- an `ActivepiecesToolkitAdapter` that maps an explicit canonical operation to one piece
  action, injects `AdapterContext` transport and credentials, and normalizes both SDK-style
  `{ status, data }` and framework-style `{ status, body }` results; and
- a boundary interface for clients that do not honor `globalThis.fetch`.

The transformer is a discovery and mapping aid. Raw Activepieces action props are not
Eyeball canonical contracts: names, requiredness, descriptions, provider extensions, safety
annotations, and output semantics still require a curated RFC 001 mapping. In particular,
an untyped Activepieces `ARRAY` can only become an unconstrained JSON array, and dynamic
dropdowns cannot be enumerated at catalog-build time.

The strict-profile regression compiles experimental shells for all 67 actions with Eyeball's
core validator. That proves structural Draft 2020-12 compatibility only; it does not supply
the canonical input/output semantics, annotations, or provider mapping required for catalog
publication.

Compatibility metadata stays in the introspection report rather than being emitted as
unknown schema keywords. This is required because Eyeball compiles schemas with strict Ajv
and RFC 001 confines provider-specific public input to `x_provider.<toolkit>`.

## 4. Per-piece result matrix and execution evidence

The tests import existing built Mockhouse packages and call their Hono applications through
`app.request`; no loopback server is used and no file under `/mocks` is changed.

| Piece | Installed | Introspected | Prototype schema transform | Executed against Mockhouse | Remaining piece-specific blocker |
|---|---|---|---|---|---|
| Gmail `send_email` | Yes, exact npm pin | 7 actions, 4 triggers, both auth declarations | Yes; all action schemas compile under the strict core profile | Yes | The bundled Google client bypasses `fetch` through Node HTTP; the custom service-account auth path and real-provider behavior remain uncertified. |
| Airtable `airtable_create_record` | Yes, exact npm pin | 15 actions, 2 triggers, secret-text auth | Yes; real `fields` hydration also passed | Yes | The piece uses a personal access token while the catalog declares OAuth2; metadata-backed dynamic fields need authenticated caching and invalidation. |
| Slack `send_channel_message` | Yes, exact npm pin | 28 actions, 14 triggers, both auth declarations | Yes; all action schemas compile under the strict core profile | Yes | The bundled Web API client bypasses `fetch` through Node HTTP; its form transport and custom bot/user-token paths need dedicated profiles. |
| Discord | Yes, exact npm pin | 16 actions, 2 triggers, secret-text auth | Yes; all action schemas compile under the strict core profile | No | No runtime transport/auth profile or mock/real action certification was attempted. |
| Typeform | Yes, exact npm pin | 1 action, 1 webhook trigger, OAuth2 auth | Yes; the action schema compiles under the strict core profile | No | The useful surface is trigger-heavy, while webhook registration/lifecycle and runtime transport remain unsupported. |

Tests disable real network access. Airtable's bundled framework helper follows
`globalThis.fetch`, so a serialized, allowlisted origin rewrite can forward it to the injected
in-process Hono mock. Gmail and Slack pass only when a separate Node HTTP boundary intercepts
every request and forwards it to the mock; Slack additionally needs test-only form-to-JSON
adaptation because the existing mock accepts JSON. The selected pieces expose no universal
base-URL environment override. This proves the action logic but also proves that injecting or
replacing `fetch` is not a sufficient production security or routing boundary.

The static transformer deliberately omits an enum for connection-backed dropdowns and emits a
described open object for `DYNAMIC` fields. It does not call provider APIs at catalog-build
time: options depend on a selected credential, upstream state, and the declared refresher
inputs. The Airtable prototype instead supplies a resolved personal-access-token credential
and dependent `base`/`tableId` values at connection time, calls the piece's real `fields`
resolver, and transforms the returned field map. A production control-plane resolver should
cache by piece version, connection, action, property, and refresher values; invalidate on
connection or refresher changes; and keep manual provider identifiers possible when dropdown
options are unavailable. A dynamic field map that cannot be hydrated must remain an explicit
provider JSON extension or be rejected by that promoted action, never silently become a
canonical contract.

## 5. Compatibility gaps

### 5.1 Runtime isolation and transport

Pieces are arbitrary third-party JavaScript with the process's filesystem, environment, and
network authority. The ordinary executor cannot safely host them. The process-wide fetch
shim is serialized among bridge calls, but unrelated concurrent code could still observe the
temporary global mutation. Bundled Node clients bypass it entirely.

A production bridge needs a dedicated worker or isolate with:

- per-execution CPU, memory, wall-clock, and output limits;
- a clean environment and no ambient credential access;
- toolkit-specific egress allowlists enforced below the JavaScript client;
- cancellation and hard termination;
- structured, redacted logs and provider error normalization; and
- one versioned transport profile per promoted piece.

### 5.2 Context surface

The shim covers the selected synchronous actions. It does not implement trigger lifecycle,
webhook registration, polling schedules, durable store semantics, waitpoints/resume,
Activepieces agent tools, cross-connection lookup, tags, incremental output, flow listing, or
production file storage. Those unsupported context calls fail explicitly. A piece using any
of those APIs is unsupported until its profile implements and tests that behavior.

### 5.3 Authentication

The common credential shapes can be adapted without exposing vault internals, but declarations
do not automatically agree with the current catalog. The clearest example is Airtable: the
tested piece accepts a secret-text personal access token, while the current Airtable manifest
declares OAuth2. That piece cannot back the manifest without an explicit product/auth decision.

OAuth connection objects also contain engine fields that `ResolvedCredential` intentionally
does not expose, such as refresh tokens and OAuth client secrets. The shim supplies only the
provider-ready access token plus inert placeholders. Any action that depends on the missing
engine fields must be rejected or adapted explicitly; the vault contract must not be widened
merely to imitate Activepieces internals.

### 5.4 Canonical semantics

Action names and schemas are provider implementation details. For example, Slack's piece
action is `send_channel_message`, while Eyeball's canonical operation is `send_message`.
Every promoted action needs an explicit input/output mapper, safety annotations, scope union,
error mapping, and provider-extension review. Automatic name conversion is not sufficient.

## 6. Dependency and license observations

On the spike machine (Node `26.4.0`, pnpm `11.9.0`), the five bundled `src/index.js` files
total 4,060,391 bytes. The five piece directories plus the explicitly pinned framework
`0.32.0` and its matching shared runtime `0.95.1` occupy 10,232 KiB before linked dependencies.
The installed production closure contains 49 unique package paths versus 13 for
`@eyeball/core` alone: 36 incremental paths occupying about 31,712 KiB (30.97 MiB). No
incremental package has an install lifecycle script, `binding.gyp`, or prebuilt `.node` file,
so the resolved spike closure has no native dependency. Notable additions include a second AI
SDK generation through the framework and `socket.io-client` through the shared package.

Contrary to the expected peer-dependency shape, the five current piece artifacts are
self-contained bundles and declare neither `@activepieces/pieces-framework` nor
`@activepieces/shared`; Gmail declares only `dayjs`. The bridge pins framework/shared anyway
as compatibility and type-surface inputs so the experiment measures them explicitly. They
must not be described as peers demanded by these five npm manifests.

Activepieces' official license documentation and repository root license state that community
core content outside the enterprise directories is MIT-licensed and that redistribution must
retain the notice:

- <https://www.activepieces.com/docs/about/license>
- <https://github.com/activepieces/activepieces/blob/main/LICENSE>

However, the seven inspected npm artifacts (five pieces, framework, and shared) omit a
`license` field, repository metadata, and an embedded `LICENSE`/`NOTICE` file. That is a
provenance and redistribution gap, not a conclusion that the source is non-MIT. Before
shipping or vendoring any piece, legal/source review must tie the exact npm integrity to an
upstream community source commit and retain the applicable copyright and license text.

## 7. Promotion checklist

A piece may move out of the experimental package only when all of these are complete:

- [ ] exact npm version, integrity, upstream source commit, and license notice recorded;
- [ ] canonical tool and provider-extension mappings reviewed against RFC 001;
- [ ] manifest auth class and effective scopes match the piece path actually executed;
- [ ] all used static and dynamic properties have deterministic schemas and fallbacks;
- [ ] action context dependencies are enumerated and unsupported APIs fail closed;
- [ ] transport runs in the isolated worker with enforced egress and deadlines;
- [ ] credentials, headers, and provider payloads are redacted from errors and logs;
- [ ] mock tests cover success, auth, validation, rate limiting, and provider failures;
- [ ] unchanged contract tests pass against a dedicated real-provider tenant; and
- [ ] an upstream update policy and rollback pin are in place.

Until then, `activepieces-bridge` in provider metadata describes the intended source strategy,
not a claim that the experimental runner backs that provider in production.
