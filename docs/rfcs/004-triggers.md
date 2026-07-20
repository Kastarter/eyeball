# RFC 004: Canonical triggers

- Status: Accepted and implemented for the 0.2.0 source release
- Date: 2026-07-18
- Last updated: 2026-07-19
- Catalog: 1.1
- Requires: RFC 001 signed delivery and execution identity contracts

## Summary

Eyeball triggers are the event-side counterpart to canonical tools. A capability owns a portable trigger contract, a provider manifest maps that contract to a polling or push ingestion mechanism, and the catalog materializes a qualified `TriggerDefinition`. A user creates a project-scoped subscription and selects existing webhook endpoints. Normalized events are then delivered by the RFC 001 signed webhook engine as `trigger.<qualified-trigger>`.

The MVP implements:

- `gmail.email_received` through cursor-based polling;
- `slack.message_received` through a secret-bearing push URL;
- project- and user-scoped subscription CRUD;
- provider-event deduplication within a 24-hour best-effort exactly-once window; and
- normal signed webhook delivery, retries, ordering, and delivery logs.

## Goals

- Give agents one typed event model across providers, just as canonical tools give them one typed action model.
- Keep credentials, provider cursors, and ingest secrets out of model-visible payloads and public subscription records.
- Reuse the existing signed webhook engine rather than introduce a second outbound delivery protocol.
- Make polling deterministic and testable through injected clocks and state stores.
- Preserve provider-only fidelity under a schema-validated `x_provider` namespace.

## Non-goals

- Historical replay, backfill, or arbitrary cursor selection.
- Provider signature verification beyond the unguessable per-subscription ingest secret.
- Automatic provider webhook registration or OAuth consent changes.
- A distributed polling scheduler or transactional provider-event claim-and-outbox boundary. Optional PostgreSQL subscription/state/dedup stores and restart-durable outbound webhook jobs are implemented.
- A guarantee that downstream webhook delivery happens exactly once. RFC 001 delivery remains at least once.

## Canonical model

Capabilities publish `CapabilityTriggerContract` values alongside tool contracts. A contract owns:

- a capability-scoped canonical name such as `email_received`;
- a stable version;
- a description and annotations; and
- a Draft 2020-12 canonical payload schema.

Provider manifests optionally declare `ProviderTriggerImplementation` entries. Each implementation binds a capability contract to one toolkit, an operation ID, required scopes, an ingestion mode, and an optional provider payload-extension schema. The catalog materializes that pair into a `TriggerDefinition`:

```ts
interface TriggerDefinition {
  name: `${ToolkitSlug}.${CanonicalTriggerName}`;
  toolkit: ToolkitSlug;
  capability: CapabilitySlug;
  description: string;
  payloadSchema: ObjectSchema202012;
  annotations: {
    deduplicated: boolean;
    replayable: boolean;
  } & (
    | {
        deliveryMode: "polling";
        defaultIntervalSeconds: number;
        minimumIntervalSeconds: number;
      }
    | {
        deliveryMode: "push";
        providerEvent: string;
      }
  );
  version: SemVer;
}
```

Qualified trigger names follow the same `<toolkit>.<operation>` shape as tools. Tool and trigger namespaces are separate, so `gmail.email_received` does not imply an executable tool.

### Payload normalization

Every payload is validated against the materialized trigger schema before delivery. Portable fields stay at the payload root. Provider-specific values may appear only under the manifest-owned extension:

```json
{
  "id": "msg_123",
  "from": "sender@example.com",
  "to": ["recipient@example.com"],
  "subject": "Invoice",
  "snippet": "Attached is...",
  "threadId": "thread_123",
  "receivedAt": "2026-07-18T09:00:00.000Z",
  "x_provider": {
    "gmail": {
      "historyId": "42",
      "labelIds": ["INBOX"]
    }
  }
}
```

The catalog rejects undeclared `x_provider` keys and extension values that fail the provider schema. Provider credentials, raw headers, request signatures, and internal cursors never enter the canonical payload.

## Subscription resource

A subscription binds one project user, one qualified trigger, an optional named connection, one or more project webhook endpoints, and optional portable filters:

```ts
interface TriggerSubscription {
  subscriptionId: `trgsub_${string}`;
  projectId: string;
  userId: string;
  trigger: QualifiedTriggerName;
  connectionId?: ConnectionId;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  pollIntervalSeconds?: number;
  status: "active" | "paused";
  createdAt: string;
  updatedAt: string;
}
```

`POST /v1/subscriptions` validates the trigger, connection, effective provider scopes, filters, cadence, and every referenced endpoint. An endpoint must subscribe to either the exact `trigger.<qualified-trigger>` event or `trigger.*`. A pinned API key may act only for its pinned user. An unpinned project key may create and manage subscriptions for any user in its project. Cross-project reads and deletes are indistinguishable from missing resources.

Push creation additionally returns an `ingestUrl`. Its secret appears only in that response; list responses and stored public records omit it. `POST /v1/subscriptions/:subscriptionId/rotate-secret` immediately invalidates the old path credential and returns its replacement once. Polling subscriptions expose their selected cadence but no provider cursor.

The MVP routes are:

- `POST /v1/subscriptions`
- `GET /v1/subscriptions?userId=&cursor=&limit=`
- `GET /v1/subscriptions/:subscriptionId`
- `POST /v1/subscriptions/:subscriptionId/rotate-secret`
- `DELETE /v1/subscriptions/:subscriptionId`
- `POST /v1/ingest/:subscriptionId/:secret`

## Ingestion modes

### Slack push

`slack.message_received` uses Slack Events API `message` callbacks. Its `ingestUrl` is intentionally callable without an Eyeball API key because the unguessable subscription secret authenticates that provider-facing route. The executor:

1. locates the active subscription by ID;
2. compares a SHA-256 digest of the supplied secret with the stored digest using a constant-time comparison;
3. resolves the subscription credential and effective scopes;
4. parses an `event_callback` message;
5. applies portable filters and normalizes the payload;
6. claims the Slack `event_id` in the dedup store; and
7. durably admits a signed `trigger.slack.message_received` webhook event when Postgres is configured.

The credential-in-path design supports providers that cannot set a custom callback header, but request targets are commonly logged. Deployments must suppress or redact `/v1/ingest/*` request targets at every proxy and APM boundary and rotate the secret after suspected disclosure.

For Slack `url_verification`, the route returns `{ "challenge": "..." }` immediately. A challenge neither creates a dedup claim nor emits a trigger event.

### Gmail polling

`gmail.email_received` uses an injected-clock scheduler and a `TriggerStateStore`. The stock adapter lists `INBOX` messages, retrieves full message metadata, and uses Gmail `historyId` as its high-water cursor. The first due poll emits all matching mailbox messages visible to the adapter. Later polls emit only messages with a higher cursor.

The subscription stores a provider-safe cadence. Gmail defaults to 60 seconds and rejects intervals below 30 seconds. On success, the state store receives the new cursor and next due time. On failure, the prior cursor is retained and the next attempt is scheduled normally. One executor process never polls the same subscription concurrently.

The scheduler remains an in-process OSS default. Without `EYEBALL_DATABASE_URL`, subscription and trigger state are also in memory. With that variable, the executor wires the committed PostgreSQL subscription, cursor, and dedup stores, and emitted events enter the durable webhook job pipeline. Production multi-replica deployments still need distributed polling leases/jobs around the same `runDue` seam.

## Deduplication and delivery semantics

Provider identity is `(subscriptionId, providerEventId)`. Before enqueueing an event, the trigger state store atomically claims that identity until `now + 24 hours`. A second push or poll observation during that window is counted as a duplicate and does not enqueue another webhook event.

This is a best-effort exactly-once ingestion window, not end-to-end exactly-once delivery:

- the zero-config stores are process-local and lose claims on restart; the optional PostgreSQL stores retain them;
- a provider may reuse an identity after the claim expires;
- a durable implementation still needs transactional claim-and-outbox behavior to close crash windows; and
- the outbound webhook engine delivers at least once, so receivers must deduplicate by webhook envelope `id` and remain idempotent.

## Signed trigger events

Trigger events use the existing webhook envelope and signature protocol:

```ts
interface TriggerWebhookEvent {
  id: string;
  type: `trigger.${QualifiedTriggerName}`;
  createdAt: string;
  projectId: string;
  data: {
    subscriptionId: TriggerSubscriptionId;
    trigger: QualifiedTriggerName;
    userId: string;
    connectionId?: ConnectionId;
    providerEventId: string;
    occurredAt: string;
    payload: Readonly<Record<string, JsonValue>>;
  };
}
```

The exact raw body is signed as `<unix-seconds>.<raw-body>` with the endpoint's RFC 001 HMAC-SHA256 secret. Trigger events use the same 10-second attempt timeout, fixed retry schedule, per-endpoint concurrency-one ordering, delivery log, and `verifyWebhookSignature` helper as execution and voice events.

## Security

- Ingest secrets contain at least 256 bits of random material, are returned once in the URL, and are stored only as SHA-256 digests.
- Secret comparisons are constant time; an invalid subscription ID, inactive subscription, wrong secret, and wrong ingestion mode all return the same not-found response.
- Subscription CRUD remains API-key authenticated and project scoped. Pinned-user conflicts return `auth_insufficient_scope`.
- Connection existence, auth class, expiry, and effective trigger scopes are validated at creation and again at ingestion or polling time.
- Provider endpoint overrides remain restricted to trusted manifest `baseUrlOverrideEnv` values.
- Normalized payloads are schema validated before entering the outbound webhook engine.
- Slack URL verification is supported, but Slack request-signature verification is deferred for MVP. Deployments should keep ingest URLs secret, rate-limit the route, and use `POST /v1/subscriptions/:subscriptionId/rotate-secret` immediately if a path credential is exposed. Ingest bodies are capped at 1 MiB before adapter parsing.

## Deferred work

- Replay and provider history backfill, including explicit start cursors.
- Slack request-signature verification and equivalent verification for future push providers.
- Automatic provider webhook lifecycle management and provider-signing-secret rotation.
- Pause/resume and subscription update routes.
- Distributed polling leases, durable scheduled jobs, atomic claim-and-outbox delivery, metrics, and dead-letter operations.
- Additional trigger contracts and provider mappings after mock and real-provider certification.
