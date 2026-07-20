# RFC 001: Canonical Tool and Execution Contracts

- Status: Accepted and implemented for the 0.2.0 source release
- Catalog baseline: 1.0
- Last updated: 2026-07-19
- Applies to: `core`, `sdk`, `bridge`, `executor`, `mcp-gateway`, `eyeball-mocks`
- Related decisions: RFC 002 and RFC 004 extend this contract; RFC 003 is subordinate to it

## 0. Scope and conformance

This RFC defines the public tool, provider, execution, error, credential, conversion,
and versioning contracts for Eyeball. The words **MUST**, **MUST NOT**, **SHOULD**,
and **MAY** are normative.

`docs/PROVIDERS.md` is the catalog authority. Its 20 capabilities, toolkit slugs,
and capability-scoped canonical tool names are frozen for catalog 1.0. An adapter
MUST conform to this RFC and MUST NOT repair a catalog mismatch by renaming a tool.

The core invariants are:

1. One capability-scoped contract defines each canonical operation.
2. Providers implement explicit subsets of those contracts.
3. Provider differences exist only below `x_provider.<toolkit-slug>`.
4. The executor validates input before resolving credentials or invoking an adapter.
5. Converters never silently weaken schemas or lose canonical name identity.
6. Provider credentials enter the executor only through `CredentialProvider`.

## 1. ToolDefinition format

### 1.1 TypeScript contract

The public core package MUST export equivalent types plus runtime validators.

```ts
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JSONSchema202012 = boolean | JSONSchemaObject202012;

export interface JSONSchemaObject202012 {
  $schema?: "https://json-schema.org/draft/2020-12/schema" | string;
  $id?: string;
  $ref?: string;
  $defs?: Readonly<Record<string, JSONSchema202012>>;
  title?: string;
  description?: string;
  type?:
    | "null" | "boolean" | "object" | "array"
    | "number" | "integer" | "string"
    | readonly ("null" | "boolean" | "object" | "array"
      | "number" | "integer" | "string")[];
  properties?: Readonly<Record<string, JSONSchema202012>>;
  required?: readonly string[];
  additionalProperties?: JSONSchema202012;
  items?: JSONSchema202012;
  enum?: readonly JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  examples?: readonly JsonValue[];
  anyOf?: readonly JSONSchema202012[];
  oneOf?: readonly JSONSchema202012[];
  allOf?: readonly JSONSchema202012[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  [keyword: string]: unknown;
}

export interface ObjectSchema202012 extends JSONSchemaObject202012 {
  type: "object";
}

export type ToolkitSlug = string;
export type CanonicalToolName = string;
export type QualifiedToolName = `${string}.${string}`;
export type SemVer = `${number}.${number}.${number}`;
export type CatalogVersion = `${number}.${number}`;

export type CapabilitySlug =
  | "email" | "calendar_scheduling" | "messaging_chat"
  | "voice_telephony" | "sms" | "crm" | "erp_accounting"
  | "social_media_data" | "social_media_publishing"
  | "file_storage_docs" | "spreadsheets_databases"
  | "project_management_dev_tools" | "payments_billing"
  | "ecommerce" | "customer_support" | "web_search_scraping"
  | "hr_recruiting" | "marketing_ads" | "sign_forms"
  | "ai_media_utilities";

export interface ToolAnnotations {
  /** True only when the tool cannot change external state. */
  readOnly: boolean;
  /** True when the tool may delete, overwrite, debit, revoke, or otherwise cause loss. */
  destructive: boolean;
  /** True when repeating the provider operation has no additional effect. */
  idempotent: boolean;
  /** True when the operation is async by nature and rejects sync mode. */
  async: boolean;
}

export interface ToolDefinition {
  /** Exactly `<toolkit>.<canonical-tool>`, for example `gmail.send_email`. */
  name: QualifiedToolName;
  toolkit: ToolkitSlug;
  capability: CapabilitySlug;
  /** LLM-facing purpose, selection guidance, exclusions, and consequences. */
  description: string;
  inputSchema: ObjectSchema202012;
  outputSchema?: ObjectSchema202012;
  annotations: ToolAnnotations;
  version: SemVer;
}
```

Every published input and output schema MUST declare Draft 2020-12 and have an object
root. Provider extension schemas are fragments and MAY omit `$schema` and `$id`; their
materialized top-level schema may not omit `$schema`. Closed objects SHOULD use
`additionalProperties: false`.

Core validation treats its supported `format` values, including `email`, `date`,
`date-time`, `uri`, and `uuid`, as assertions. JSON Schema `default` is only an annotation,
so before validation the executor MUST insert a declared property default when that
property is absent. It MUST NOT replace explicit `null` or another supplied value. The
defaulted, validated value is the canonical input used by the request hash, adapter, and
execution log.

Annotations are required hints for trusted clients; they never replace authorization,
policy, validation, or approval. `destructive: false` does not mean harmless: additive
external actions such as sending email still have `readOnly: false` and require the
caller's mutation policy. Executor-level idempotency does not change a provider operation's
`idempotent` annotation.

### 1.2 Complete `gmail.send_email` example

This materializes the Email capability's one `send_email` contract for Gmail. Apart from
the qualified name, schema identity metadata (`$id`), and `x_provider`, every path is
identical for every provider implementing `send_email`.

```ts
export const gmailSendEmail: ToolDefinition = {
  name: "gmail.send_email",
  toolkit: "gmail",
  capability: "email",
  description:
    "Send a new email from the connected email account. Use this for a new " +
    "conversation, not a reply to an existing message or thread. This sends " +
    "content to external recipients; verify recipients, subject, and body first.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:eyeball:email:send_email:1.1.0:gmail",
    type: "object",
    additionalProperties: false,
    required: ["to", "subject", "body"],
    properties: {
      to: {
        type: "array",
        description: "Primary recipient email addresses.",
        minItems: 1,
        items: { type: "string", format: "email" },
      },
      cc: {
        type: "array",
        description: "Carbon-copy recipient email addresses.",
        items: { type: "string", format: "email" },
      },
      bcc: {
        type: "array",
        description: "Blind-carbon-copy recipient email addresses.",
        items: { type: "string", format: "email" },
      },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: {
        type: "string",
        minLength: 1,
        description: "Complete body in the format selected by bodyFormat.",
      },
      bodyFormat: { type: "string", enum: ["text", "html"], default: "text" },
      replyTo: { type: "string", format: "email" },
      attachments: {
        type: "array",
        maxItems: 25,
        description: "Previously staged Eyeball files to attach.",
        items: {
          anyOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["fileId"],
              properties: {
                fileId: { type: "string", pattern: "^file_" },
                name: { type: "string", minLength: 1 },
                mimeType: { type: "string", minLength: 1 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["fileId", "fileName"],
              deprecated: true,
              properties: {
                fileId: { type: "string", minLength: 1 },
                fileName: { type: "string", minLength: 1 },
                contentType: { type: "string" },
              },
            },
          ],
        },
      },
      x_provider: {
        type: "object",
        additionalProperties: false,
        properties: {
          gmail: {
            type: "object",
            additionalProperties: false,
            properties: {
              sendAs: {
                type: "string",
                format: "email",
                description: "A verified Gmail send-as identity.",
              },
            },
          },
        },
      },
    },
  },
  outputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:eyeball:email:send_email:output:1.1.0:gmail",
    type: "object",
    additionalProperties: false,
    required: ["messageId", "acceptedRecipients"],
    properties: {
      messageId: { type: "string" },
      threadId: { type: "string" },
      acceptedRecipients: {
        type: "array",
        items: { type: "string", format: "email" },
      },
    },
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: "1.1.0",
};
```

## 2. Capability contracts and provider manifests

### 2.1 One contract, explicit provider subsets

```ts
export interface CapabilityToolContract {
  capability: CapabilitySlug;
  name: CanonicalToolName;
  description: string;
  inputSchema: ObjectSchema202012;
  outputSchema?: ObjectSchema202012;
  annotations: ToolAnnotations;
  version: SemVer;
}

export type AuthClass = "oauth2" | "api_key" | "basic" | "none";
export type ProviderSource = "activepieces-bridge" | "native" | "scrapecreators";
export type DeliveryTier = "P0" | "P1" | "P2";

export interface ProviderAuthRequirement {
  class: AuthClass;
  requiredScopes?: readonly string[];
  optionalScopes?: readonly string[];
  /** Logical credential keys, such as `apiKey` or `accountSid`. */
  fields?: readonly string[];
}

export interface ProviderToolImplementation {
  capability: CapabilitySlug;
  canonicalTool: CanonicalToolName;
  canonicalVersion: SemVer;
  operationId: string;
  requiredScopes?: readonly string[];
  /** Schema for `input.x_provider[manifest.toolkit.slug]` only. */
  inputExtensionSchema?: ObjectSchema202012;
  /** Schema for `output.x_provider[manifest.toolkit.slug]` only. */
  outputExtensionSchema?: ObjectSchema202012;
}

export interface ProviderManifest {
  schemaVersion: "1.0";
  catalogVersion: CatalogVersion;
  toolkit: {
    slug: ToolkitSlug;
    displayName: string;
    source: ProviderSource;
    tier: DeliveryTier;
  };
  auth: ProviderAuthRequirement;
  endpoint: {
    baseUrl: string;
    /** Trusted executor env var used by eyeball-mocks; never tool input. */
    baseUrlOverrideEnv?: string;
  };
  implements: readonly ProviderToolImplementation[];
}
```

Absence from `implements` is authoritative. The gateway MUST omit that tool, and a
direct stale call MUST return `not_supported`; an adapter MUST NOT emulate another
operation. Provider extensions MUST appear only at `x_provider.<manifest slug>`.
The executor rejects unknown sibling slugs and provider fields at the top level.

Materialization is mechanical: resolve the named capability contract and version, deep-copy
it, set the qualified name and provider-specific `$id` values, and graft each declared
extension schema under the matching provider key. It MUST NOT modify requiredness, types,
descriptions, annotations, or semantics elsewhere. An implementation referencing an unknown
contract/version or placing an extension outside `x_provider` is a catalog build error.
The effective required scopes are the union of `auth.requiredScopes` and the selected
implementation's `requiredScopes`; the executor checks them before adapter invocation.

### 2.2 Gmail manifest

```ts
export const gmailManifest: ProviderManifest = {
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "gmail",
    displayName: "Gmail",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    requiredScopes: ["https://www.googleapis.com/auth/gmail.modify"],
    optionalScopes: ["https://www.googleapis.com/auth/gmail.send"],
  },
  endpoint: {
    baseUrl: "https://gmail.googleapis.com",
    baseUrlOverrideEnv: "EYEBALL_GMAIL_BASE_URL",
  },
  implements: [
    {
      capability: "email",
      canonicalTool: "send_email",
      canonicalVersion: "1.0.0",
      operationId: "users.messages.send",
      inputExtensionSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sendAs: {
            type: "string",
            format: "email",
            description: "A verified Gmail send-as identity.",
          },
        },
      },
    },
    { capability: "email", canonicalTool: "list_emails", canonicalVersion: "1.0.0", operationId: "users.messages.list" },
    { capability: "email", canonicalTool: "get_email", canonicalVersion: "1.0.0", operationId: "users.messages.get" },
    { capability: "email", canonicalTool: "reply_to_email", canonicalVersion: "1.0.0", operationId: "users.messages.sendReply" },
    { capability: "email", canonicalTool: "create_draft", canonicalVersion: "1.0.0", operationId: "users.drafts.create" },
    { capability: "email", canonicalTool: "search_emails", canonicalVersion: "1.0.0", operationId: "users.messages.search" },
    { capability: "email", canonicalTool: "list_threads", canonicalVersion: "1.0.0", operationId: "users.threads.list" },
    { capability: "email", canonicalTool: "add_email_label", canonicalVersion: "1.0.0", operationId: "users.messages.modify" },
  ],
};
```

Only trusted process configuration may set `EYEBALL_GMAIL_BASE_URL`. SDK requests,
users, project data, and LLM input MUST NOT select an adapter base URL.
A client-level mock option MAY select a dedicated Eyeball executor endpoint that the operator
has already configured with manifest overrides and `MockCredentialProvider`; it MUST NOT
appear in `ExecuteRequest`, switch a provider destination per call, or alter credential mode
inside an authenticated production executor.

## 3. Execution API

### 3.1 Wire types

The API key identifies `projectId`; it is deliberately absent from the request body.
An unpinned project key is the authority for every end user in that project: the authenticated
caller may select any `userId` and its project-scoped connections. Operators MAY instead use
the keyring form `key:projectId:userId` to pin a key to one end user; the executor and MCP
gateway MUST reject any conflicting body, header, query, or MCP `_meta` identity. Use pinned
keys when a project credential is delegated to a less-trusted MCP host. The legacy
`key:projectId` form intentionally retains project-wide authority.
`userId` is the developer's stable external-user identifier. A supplied `connectionId`
MUST belong to that project, user, and tool's toolkit. When it is absent, the executor uses
the sole usable connection or the connection explicitly marked default; ambiguity returns
`auth_missing`. Cross-project and cross-user mismatches also return `auth_missing` so the
endpoint does not reveal whether another tenant's connection exists.

```ts
export type ExecutionMode = "sync" | "async";
export type ExecutionStatus = "pending" | "running" | "succeeded" | "failed";

export interface ExecuteRequest {
  tool: QualifiedToolName;
  userId: string;
  connectionId?: string;
  input: Readonly<Record<string, JsonValue>>;
  mode?: ExecutionMode;
}

export interface ExecutionBase {
  executionId: string;
  tool: QualifiedToolName;
  toolVersion: SemVer;
  catalogVersion: CatalogVersion;
  status: ExecutionStatus;
}

export type SyncExecuteResponse =
  | ExecutionBase & {
      status: "succeeded";
      output: JsonValue;
      error?: never;
      latencyMs: number;
    }
  | ExecutionBase & {
      status: "failed";
      output?: never;
      error: NormalizedToolError;
      latencyMs: number;
    };

export type AsyncExecuteResponse = ExecutionBase & { status: "pending" };

export type ExecutionRecord = ExecutionBase & {
  userId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
} & (
  | { status: "pending" | "running"; output?: never; error?: never; latencyMs?: never }
  | { status: "succeeded"; output: JsonValue; error?: never; latencyMs: number }
  | { status: "failed"; output?: never; error: NormalizedToolError; latencyMs: number }
);
```

`POST /v1/execute` accepts exactly `ExecuteRequest`; when `mode` is absent it defaults to
`async` for an async-by-nature definition and `sync` otherwise. Sync mode waits and returns
`SyncExecuteResponse` with HTTP 200. Async mode allocates once and immediately returns
`AsyncExecuteResponse` with HTTP 202. `GET /v1/executions/:id` returns the current
`ExecutionRecord`. Valid transitions are `pending -> running -> succeeded|failed` and
`pending -> failed`; terminal records are immutable.

After API-key authentication, execution order is fixed: resolve the pinned catalog
definition and provider implementation; default and validate canonical input; apply
idempotency; ask `CredentialProvider` to resolve or select the connection; verify the
returned auth class and effective scopes; call the adapter; normalize provider failures;
validate successful output; and persist the terminal record. Credentials MUST NOT be
resolved before input validation. Invalid adapter output fails the execution with
`provider_error` and is never returned as successful output.

Once an execution is allocated, tool failures are represented by `status: "failed"` rather
than only by HTTP status. After successful project authentication, malformed input or another
request rejected before allocation uses `ErrorEnvelope`. Invalid API-key responses use the
platform authentication envelope defined by the control-plane API, outside this RFC. A sync
request for an `async: true` tool is rejected before allocation with HTTP 422 and
`invalid_input`.

### 3.2 Project-scoped staged files

`POST /v1/files` stages bytes for later adapter use. The primary wire format is JSON with
canonical padded base64 content:

```http
POST /v1/files
Authorization: Bearer ey_live_...
Content-Type: application/json

{"name":"receipt.pdf","mimeType":"application/pdf","content":"JVBERi0xLjcK...=="}
```

```json
{"fileId":"file_01JZ7F4Y8E7H48H3Y2NQ4J5H8P","name":"receipt.pdf","mimeType":"application/pdf","size":18422,"expiresAt":"2026-07-17T14:00:00.000Z"}
```

`GET /v1/files/:id` returns that metadata only. There is no public content-download route:
adapter execution resolves bytes through the project-bound `AdapterContext.files` resolver.
The `FileStore` lookup key includes the authenticated project, and a missing, expired, or
cross-project identifier returns the same `not_found` response. The API uses the same API-key
and pinned-user middleware as every `/v1/*` route. Files are not independently user-owned:
any caller authorized for the same project, including a different pinned user who learns the
high-entropy file ID, may retrieve its metadata or reference its bytes during the file's TTL.

The process-local defaults are a 25 MiB decoded-byte limit and a one-hour TTL. Operators may
set `EYEBALL_FILE_MAX_BYTES` and `EYEBALL_FILE_TTL_MS`; durable disk/object-store implementations
replace `InMemoryFileStore` behind the same `FileStore` interface. Expiry is evaluated against
the injected executor clock. Canonical email attachments use `{ fileId, name?, mimeType? }`.
`file_storage_docs.upload_file` accepts `fileId` instead of inline `content`, with exactly one
content source per call.

### 3.3 Annotation-driven async behavior

If `annotations.async` is true, `mode: "sync"` fails as described above. A tool with
`async: false` accepts either mode; async mode queues it. The SDK defaults the mode from
the annotation, and the executor reads the resolved definition. Neither may match names.

Catalog 1.0 marks these capability contracts async by nature:

- `voice_telephony.start_call`
- `voice_telephony.start_voice_pipeline`
- `web_search_scraping.crawl_site`

### 3.4 `gmail.send_email` sync example

```http
POST /v1/execute
Authorization: Bearer ey_live_...
Idempotency-Key: checkout-481-email-v1
Content-Type: application/json

{"tool":"gmail.send_email","userId":"user_123","input":{"to":["buyer@example.com"],"subject":"Your receipt","body":"Thanks for your order.","bodyFormat":"text"},"mode":"sync"}
```

```json
{"executionId":"exe_01JZ6W8V3Y8XKJX2W4ZJ6C6M7P","tool":"gmail.send_email","toolVersion":"1.1.0","catalogVersion":"1.1","status":"succeeded","output":{"messageId":"18f7b31a52","threadId":"18f7b31a52","acceptedRecipients":["buyer@example.com"]},"latencyMs":842}
```

### 3.5 `twilio.start_call` async example

The separate Voice Agent RFC owns the referenced agent's model, prompt, speech,
transport, tools, safety policy, and recording policy.

```http
POST /v1/execute
Authorization: Bearer ey_live_...
Idempotency-Key: renewal-call-customer-481-v1
Content-Type: application/json

{"tool":"twilio.start_call","userId":"customer_481","connectionId":"conn_twilio_primary","input":{"to":"+966500000000","from":"+12025550173","voiceAgentId":"vag_renewals_ar_01"},"mode":"async"}
```

```json
{"executionId":"exe_01JZ6WA0Q73ZQ5B51SRYB6M4Z8","tool":"twilio.start_call","toolVersion":"1.0.0","catalogVersion":"1.0","status":"pending"}
```

Polling later may return:

```json
{"executionId":"exe_01JZ6WA0Q73ZQ5B51SRYB6M4Z8","tool":"twilio.start_call","toolVersion":"1.0.0","catalogVersion":"1.0","userId":"customer_481","createdAt":"2026-07-16T00:00:00Z","startedAt":"2026-07-16T00:00:01Z","completedAt":"2026-07-16T00:01:35Z","status":"succeeded","output":{"callId":"call_01JZ6WA6T6J78X7W39P4Q7J12K","state":"completed","durationSeconds":94},"latencyMs":95231}
```

### 3.6 Idempotency

`Idempotency-Key` is REQUIRED when `annotations.readOnly` is false and OPTIONAL for
reads. Keys are scoped to project, qualified tool, user, caller-supplied connection (or an
explicit `default` sentinel), and catalog major. The request hash covers the complete
`ExecuteRequest` after defaults and deterministic JSON-key ordering. The executor retains
the key, hash, resolved connection, and execution reference for at least 24 hours.

The same key and request return the original `executionId` and latest state. The same
key with a different request returns HTTP 409 with `invalid_input`. Async retries never
allocate a second job. Provider-native idempotency may supplement but never replace this.

REST callers supply the header directly. SDK direct calls accept `idempotencyKey`; when it
is omitted for a mutation, the SDK generates a fresh UUID for that invocation. Anthropic and
OpenAI dispatch helpers prefix the model provider's stable tool-call ID. The MCP gateway uses
`mcp:<session-id>:<JSON-RPC-request-id>` and accepts an explicit
`params._meta["dev.eyeball/idempotencyKey"]` override for correlation across sessions. These
surface keys enter the same executor scope, replay, conflict, and retention rules above. A
converter callback that does not receive a stable provider call ID still gets a fresh SDK UUID
per invocation and remains subject to the deferred correlation decision in Section 8.

### 3.7 Terminal webhook delivery

Webhook endpoints are project configuration, not fields in `ExecuteRequest`.

```ts
export type TerminalEventType = "execution.succeeded" | "execution.failed";

export interface WebhookEndpointConfig {
  id: string;
  url: string;
  events: readonly TerminalEventType[];
  secretReference: string;
  active: boolean;
}

export interface ExecutionWebhookEvent {
  id: string;
  type: TerminalEventType;
  createdAt: string;
  projectId: string;
  data: ExecutionRecord & { status: "succeeded" | "failed" };
}
```

Delivery is at least once; receivers deduplicate by event `id`. The sender signs
`<timestamp>.<raw-body>` with HMAC-SHA256. Any 2xx acknowledges delivery; other results
receive bounded exponential retries. Endpoint CRUD belongs to the project control plane.

**Companion decision — signed delivery profile (2026-07-17).** The timestamp is decimal
Unix seconds and the raw body is the exact UTF-8 JSON byte sequence sent on the wire. The
signature is lowercase hexadecimal in `v1=<64 hex characters>` form. New senders emit
`Eyeball-Webhook-Id`, `Eyeball-Webhook-Timestamp`, and `Eyeball-Webhook-Signature`;
they also emit the original `Eyeball-Timestamp` and `Eyeball-Signature` names during the
source-preview compatibility window. Verification accepts either timestamp/signature pair
with a five-minute tolerance. The webhook ID is the stable event `id`, not an attempt ID.

The implemented retry delays before attempts are `0s`, `30s`, `2m`, `10m`, and `1h`;
each receiver request has a 10-second default timeout.
Retries and later events are serialized at concurrency one per endpoint, providing
best-effort per-endpoint order but no global ordering. Delivery scheduling is asynchronous
after the terminal record update and never waits for receiver I/O or retries. The zero-config
source default uses in-memory project endpoint, delivery, work, and task stores.
`EYEBALL_DATABASE_URL` wires the committed PostgreSQL implementations for those stores: the
exact raw body is persisted before an ID-only selection job is admitted, each selected endpoint
URL/secret snapshot is persisted before its delivery job is admitted, delivery attempts use
leased jobs with durable `runAfter` deadlines, and startup recovery restores unfinished work
before claims begin. `execution.completed` is a
subscription-only convenience selector that matches both terminal event types without changing
envelope types.

## 4. Error taxonomy

Every adapter MUST map provider failures into this closed set.

```ts
export type ToolErrorCode =
  | "invalid_input" | "auth_missing" | "auth_expired"
  | "auth_insufficient_scope" | "not_found" | "rate_limited"
  | "provider_unavailable" | "provider_error" | "timeout"
  | "not_supported" | "execution_interrupted";

export interface NormalizedToolError {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  /** Non-negative seconds; used with rate_limited when known. */
  retryAfter?: number;
  provider?: {
    toolkit: ToolkitSlug;
    status?: number;
    code?: string;
    requestId?: string;
    /** Sanitized provider payload; secrets and auth headers are forbidden. */
    detail?: JsonValue;
  };
}

export interface ErrorEnvelope {
  error: NormalizedToolError;
  requestId: string;
  /** Pre-allocation errors have no execution identity. */
  executionId?: never;
}
```

```json
{"executionId":"exe_01JZ6WQ1YB6E7VQZZY2H5W7E1F","tool":"gmail.send_email","toolVersion":"1.0.0","catalogVersion":"1.0","status":"failed","error":{"code":"rate_limited","message":"Gmail send quota was exceeded.","retryable":true,"retryAfter":60,"provider":{"toolkit":"gmail","status":429,"code":"rateLimitExceeded","requestId":"google-request-7e21","detail":{"reason":"userRateLimitExceeded"}}},"latencyMs":311}
```

| Condition | Code | Default retryable |
|---|---|---:|
| Canonical validation failure | `invalid_input` | false |
| No usable connection | `auth_missing` | false |
| Expired token with no refresh, or refresh rejected | `auth_expired` | false |
| Missing provider scope or permission | `auth_insufficient_scope` | false |
| Requested provider object absent | `not_found` | false |
| Quota rejection or HTTP 429 | `rate_limited` | true |
| Transient outage, DNS, or provider gateway failure | `provider_unavailable` | true |
| Credential provider temporarily unavailable | `provider_unavailable` | true |
| Adapter output violates the canonical output schema | `provider_error` | false |
| Other sanitized provider failure | `provider_error` | adapter-defined |
| Executor/provider deadline exceeded | `timeout` | only when no side effect occurred or idempotency protects retry |
| Manifest omits the canonical tool | `not_supported` | false |
| Restart leaves provider dispatch outcome ambiguous | `execution_interrupted` | false |

Clients branch on `code`, not HTTP status or provider text. Adapters redact credentials,
cookies, authorization headers, and unrelated user data before setting `provider.detail`.
`ErrorEnvelope` is used only for an error after project authentication but before execution
allocation. Accepted execution failures use `SyncExecuteResponse` or `ExecutionRecord`.

## 5. CredentialProvider: the open-core seam

### 5.1 Contract

```ts
export interface CredentialContext {
  projectId: string;
  userId: string;
  toolkitSlug: ToolkitSlug;
  connectionId?: string;
}

export interface ResolvedCredentialBase {
  /** Actual selected connection; omitted only by local `none`/legacy env fixtures. */
  connectionId?: string;
  expiresAt?: string;
  scopes?: readonly string[];
}

export interface OAuth2Credential extends ResolvedCredentialBase {
  type: "oauth2";
  accessToken: string;
  tokenType?: string;
}

export interface ApiKeyCredential extends ResolvedCredentialBase {
  type: "api_key";
  /** Named tuple; the adapter owns placement and signing. */
  values: Readonly<Record<string, string>>;
}

export interface BasicCredential extends ResolvedCredentialBase {
  type: "basic";
  username: string;
  password: string;
  parameters?: Readonly<Record<string, string>>;
}

export interface NoCredential extends ResolvedCredentialBase { type: "none"; }

export type ResolvedCredential =
  | OAuth2Credential | ApiKeyCredential | BasicCredential | NoCredential;

export type CredentialRefreshReason =
  | "expiring" | "expired" | "provider_unauthorized";

export type CredentialProviderErrorCode =
  | "auth_missing" | "auth_expired" | "auth_insufficient_scope"
  | "provider_unavailable";

export interface CredentialProviderErrorOptions {
  code: CredentialProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  cause?: unknown;
}

export declare class CredentialProviderError extends Error {
  readonly code: CredentialProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  constructor(options: CredentialProviderErrorOptions);
}

export interface CredentialRefreshContext extends CredentialContext {
  current: OAuth2Credential;
  reason: CredentialRefreshReason;
}

export interface CredentialProvider {
  readonly kind: "env" | "mock" | "local-vault" | "cloud";
  resolve(context: CredentialContext): Promise<ResolvedCredential>;
  refresh?(context: CredentialRefreshContext): Promise<OAuth2Credential>;
  invalidate?(context: CredentialContext): Promise<void>;
}
```

Resolved credentials exist only in executor memory for one attempt. They MUST NOT enter
logs, traces, execution records, outputs, webhooks, caches, or error details. The adapter
MUST verify the credential discriminant matches the manifest auth class.
Expected lookup, expiry, scope, and vault-availability failures MUST reject with
`CredentialProviderError`; the executor preserves its normalized code but never exposes a
vault response body. Unexpected implementation exceptions are internal API failures, not
sanitized provider errors.

### 5.2 Required implementations

```ts
export type EnvCredentialMapping =
  | { type: "oauth2"; accessTokenEnv: string; expiresAtEnv?: string; scopesEnv?: string }
  | { type: "api_key"; valueEnvs: Readonly<Record<string, string>> }
  | { type: "basic"; usernameEnv: string; passwordEnv: string; parameterEnvs?: Readonly<Record<string, string>> }
  | { type: "none" };

export interface EnvCredentialProviderOptions {
  mappings: Readonly<Record<ToolkitSlug, EnvCredentialMapping>>;
  env?: Readonly<Record<string, string | undefined>>;
  /** The only project allowed to resolve these process-wide credentials. */
  allowedProjectId: string;
  /** The only external user allowed within that project. */
  allowedUserId: string;
}

export declare class EnvCredentialProvider implements CredentialProvider {
  readonly kind: "env";
  constructor(options: EnvCredentialProviderOptions);
  resolve(context: CredentialContext): Promise<ResolvedCredential>;
}

export interface MockCredentialFixture {
  match: CredentialContext;
  credential: ResolvedCredential;
  refreshTo?: OAuth2Credential;
}

export declare class MockCredentialProvider implements CredentialProvider {
  readonly kind: "mock";
  constructor(fixtures: readonly MockCredentialFixture[]);
  resolve(context: CredentialContext): Promise<ResolvedCredential>;
  refresh?(context: CredentialRefreshContext): Promise<OAuth2Credential>;
}

/** OSS single-tenant encrypted JSON-file credential store. */
export declare class LocalVaultCredentialProvider implements CredentialProvider {
  readonly kind: "local-vault";
  constructor(options: {
    filePath: string;
    allowedProjectId: string;
    oauth?: Readonly<Record<ToolkitSlug, { tokenUrl: string }>>;
  });
  resolve(context: CredentialContext): Promise<ResolvedCredential>;
  refresh(context: CredentialRefreshContext): Promise<OAuth2Credential>;
}

/** Public contract; the HTTP client lives in the OSS executor and storage in Cloud. */
export interface CloudCredentialProvider extends CredentialProvider {
  readonly kind: "cloud";
}
```

- `EnvCredentialProvider` is the OSS toy: process env, static credentials, one allowed
  project/user pair, no OAuth flow, and no durable refresh. A context mismatch returns
  `auth_missing`; process-wide credentials can never fall through to another project.
- `MockCredentialProvider` is deterministic and accepts `fixture:`-prefixed test secrets;
  it supports valid, expired, refresh, missing, and insufficient-scope fixtures.
- `LocalVaultCredentialProvider` is the durable OSS/self-host path: one encrypted JSON file,
  AES-256-GCM records under `EYEBALL_VAULT_KEY`, fresh per-write nonce derivation,
  single-process write serialization, expiry checks, refresh-token rotation, and in-flight
  refresh deduplication. It is single-tenant infrastructure, not a substitute for the hosted
  connection vault.
- The executor's hosted credential provider calls the private Auth Vault API. Cloud selects
  the connection and refreshes OAuth before returning a short-lived provider-ready credential.

The executor MAY refresh proactively. It retries after an auth rejection at most once,
and only if no side effect occurred or platform/provider idempotency protects the call.

## 6. Format conversion guarantees

### 6.1 Naming and reversible mangling

```text
toolkit:   ^[a-z0-9]+(?:-[a-z0-9]+)*$
operation: ^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$
qualified: <toolkit>.<operation>, exactly one dot, at most 63 characters
```

The 63-character limit guarantees that replacing one dot with two underscores remains
within 64 characters. Components containing `__` are forbidden.

MCP 2025-11-25 permits dots, so MCP preserves `gmail.send_email`. Anthropic tool names
allow the restricted letters/digits/`_`/`-` form up to 128 characters, while OpenAI function
names use that form with a 64-character maximum. Eyeball deliberately targets their 64-character
intersection and uses `__` as the namespace separator. Vercel AI SDK tool-set keys use the
same portable restricted form because the selected downstream model provider enforces the
final tool name.

```text
gmail.send_email        <-> gmail__send_email
twilio.start_call       <-> twilio__start_call
instagram-data.get_post <-> instagram-data__get_post
```

```ts
export interface ToolNameMap {
  canonicalToWire: Readonly<Record<QualifiedToolName, string>>;
  wireToCanonical: Readonly<Record<string, QualifiedToolName>>;
}

export function toRestrictedToolName(name: QualifiedToolName): string {
  if (name.length > 63 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Invalid canonical tool name: ${name}`);
  }
  const parts = name.split(".");
  const wire = `${parts[0]}__${parts[1]}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(wire)) throw new Error("Unportable tool name");
  return wire;
}

export function fromRestrictedToolName(name: string): QualifiedToolName {
  const parts = name.split("__");
  if (parts.length !== 2) throw new Error(`Unknown tool name: ${name}`);
  const canonical = `${parts[0]}.${parts[1]}` as QualifiedToolName;
  if (toRestrictedToolName(canonical) !== name) {
    throw new Error(`Unknown tool name: ${name}`);
  }
  return canonical;
}
```

Catalog compilation fails on a collision, invalid character, length violation, or
non-reversible name. Runtime dispatch MUST use the emitted `ToolNameMap`, not parse an
untrusted model string with `fromRestrictedToolName` alone.

### 6.2 Field mapping and losslessness

| Canonical field | Anthropic | OpenAI function | Vercel AI SDK | MCP `tools/list` |
|---|---|---|---|---|
| `name` | `gmail__send_email` | `gmail__send_email` | key `gmail__send_email` | `gmail.send_email` |
| `description` | `description` | `description` | `description` | `description` |
| `inputSchema` | `input_schema` | `parameters` | `inputSchema` | `inputSchema` |
| `outputSchema` | sidecar | sidecar | `outputSchema` | `outputSchema` |
| safety hints | sidecar | sidecar | sidecar/approval | MCP hint annotations |
| `async` | wrapper/sidecar | wrapper/sidecar | async `execute` | versioned Tasks profile |
| toolkit/capability/version | sidecar | sidecar | sidecar | `_meta` |

Converters return the native descriptor plus the name map and full immutable definition
sidecar. That bundle is lossless even where a provider's native descriptor cannot carry
output schema, annotations, capability, or version. Executor input/output validation
always uses the canonical definition.

MCP maps `readOnly`, `destructive`, and `idempotent` to the corresponding `*Hint`
properties. In a session pinned to MCP 2025-11-25 where the gateway declared
`tasks.requests.tools.call`, it maps `async: true` to `taskSupport: "required"` and
`async: false` to `"optional"`. If that Tasks protocol is not negotiated, the gateway MUST
omit `async: true` tools from `tools/list`; it MUST NOT return a nonstandard pending payload
where the advertised canonical `outputSchema` promises a terminal result. The REST/SDK
surface remains available for those calls. MCP always receives the canonical dotted name.

For a successful non-task `tools/call`, MCP returns canonical output in
`structuredContent` and SHOULD also include its JSON serialization as text for older clients.
If `outputSchema` is present, that structured content MUST validate before return. A failed
execution sets `isError: true` and returns the normalized error as tool-result content rather
than pretending it conforms to the success schema. In a task-augmented call, the eventual
`tasks/result` contains this same terminal tool result.

Every terminal MCP tool result backed by an allocated execution MUST also include this
namespaced metadata outside `structuredContent`:

```ts
export interface McpExecutionMeta extends ExecutionBase {
  status: "succeeded" | "failed";
  latencyMs: number;
}

export interface McpToolResultMeta {
  "dev.eyeball/execution": McpExecutionMeta;
}
```

This is inspection metadata, not canonical tool output, so it is not part of `outputSchema`
and is not sent back to an adapter. A pre-allocation failure has no execution entry. The
eventual `tasks/result` uses the same rule, letting an MCP client link a terminal result to
the REST/admin execution record without changing model-visible canonical output.

Canonical schemas are Draft 2020-12. A converter MUST copy the exact schema; it cannot
drop keywords, broaden enums, change requiredness, or coerce types. Anthropic/OpenAI
strict mode is enabled only when a version-pinned compatibility validator accepts the
exact schema. Otherwise the converter emits non-strict mode and Eyeball still validates.
If a target rejects the schema even in non-strict mode, catalog compilation for that
format fails with a diagnostic; there is no lossy fallback.

### 6.3 Streamable HTTP session and Tasks profile

The source gateway implements the MCP 2025-11-25 Streamable HTTP endpoint at `/mcp`.
Every client JSON-RPC message uses POST. A request that accepts `text/event-stream` receives
an SSE stream with an initial empty event, zero or more related notifications, and the final
JSON-RPC response; other POST requests receive one JSON response. An authenticated GET with
`Accept: text/event-stream` opens a session notification stream, and authenticated DELETE
terminates the supplied session. Browser `Origin` headers MUST match the explicit operator
allowlist before authentication runs; when the allowlist is empty, requests carrying `Origin`
are rejected because the HTTP `Host` value is not a DNS-rebinding trust anchor.

Initialization returns a cryptographically random `Mcp-Session-Id`. Subsequent stateful
requests MUST supply that server-issued ID and the negotiated protocol header; invented,
expired, deleted, or differently authenticated IDs return HTTP 404. The default session TTL
is 24 hours. Session state is stored through `SessionStore`; the stock implementation is
process-local, while injected durable implementations MUST make read-modify-write updates
atomic. Stored sessions contain a one-way inbound-credential binding, never the credential.
SSE listeners, polling timers, and bearer credentials remain process-local. Event IDs are
emitted for Streamable HTTP framing, but this source profile does not persist an event replay
log and therefore does not promise `Last-Event-ID` redelivery.

Because Tasks remain experimental, Eyeball requires an explicit per-session opt-in at
`InitializeRequest.params.capabilities.experimental.tasks`. If the executor implements both
async allocation and execution lookup, the server then declares
`capabilities.tasks.requests.tools.call`, includes async tools in discovery, and emits the
tool-level `execution.taskSupport` values described above. Without that opt-in, the legacy
terminal result profile remains unchanged. In search discovery mode,
`eyeball.execute_tool` is `optional`; the resolved canonical async definition still requires
task augmentation.

A task-augmented call allocates the canonical execution in async mode and uses its `exe_*`
identifier as the MCP `taskId`. The requested TTL is validated as a positive integer and
defaults to one hour. Executor `pending|running|succeeded|failed` map to MCP
`working|working|completed|failed`. `tasks/get` refreshes the project-scoped execution,
and `tasks/result` waits for terminal state and returns the same `CallToolResult` used by a
non-task call with `io.modelcontextprotocol/related-task` metadata. Task state is scoped to
the authenticated session. Expired or cross-session IDs return JSON-RPC `-32602` without
revealing another task.

The gateway polls active executions at a configurable interval (one second by default).
When the originating `_meta` includes `progressToken`, queued, running, and terminal
transitions MAY publish `notifications/progress`; terminal transitions MAY also publish
`notifications/tasks/status`. Clients MUST continue using `tasks/get` as the source of truth.
The server advertises `tasks.cancel` only when an injected `McpExecutor` implements the
optional cancellation seam. The stock executor has no cancellation route and does not
advertise it. `tasks/list` is not advertised.

## 7. Versioning and stability

```ts
export interface CatalogManifest {
  catalogVersion: CatalogVersion;
  generatedAt: string;
  tools: readonly ToolDefinition[];
  providers: readonly ProviderManifest[];
}
```

The catalog uses `MAJOR.MINOR` and starts at `1.0`. Each tool independently uses SemVer.
Projects pin a catalog major; executions store the resolved catalog and tool versions.

A tool major bump and catalog major bump are required for:

- renaming/removing a toolkit, capability contract, or qualified tool;
- changing the `.` / `__` naming invariant;
- adding required input, removing input, or narrowing accepted input;
- removing or incompatibly changing output fields or semantics;
- changing read-only to mutating, non-destructive to destructive, or sync to async;
- moving provider-specific data into or out of the canonical top level;
- changing a provider auth class, removing an implementation, or adding required scope.

A tool minor bump covers optional input, input widening, and backward-compatible output
additions. A patch covers descriptions, examples, or metadata with no accepted-value,
safety, or execution change. Catalog minor increments for additive providers/tools or
compatible revisions. Old catalog majors remain executable for the published deprecation
window; aliases are discovery-only and resolve to one explicit definition before execution.

The staged-file revision is input widening, not a breaking replacement: email retains the
deprecated `{ fileId, fileName, contentType? }` branch while adding the preferred
`{ fileId, name?, mimeType? }` branch, and storage adds `fileId` as an alternative to inline
content. Those tools therefore move to `1.1.0`, not `2.0.0`. The source catalog remains `1.1`
because this repository is still the unpublished package preview; a published catalog would
receive the next compatible catalog minor before this revision shipped.

## 8. Deferred companion decisions

1. The Voice Agent RFC must finalize how catalog 1.0 `voiceAgentId` maps to catalog 1.1
   agent IDs and immutable revisions.
2. Project endpoint create/list/get/update/delete, signing-secret rotation, and delivery-log
   reads use `/v1/webhooks` in the source preview.
3. MCP 2025-11-25 Tasks remain experimental and adapter-versioned; a future task wire profile
   may replace the implemented profile without changing Eyeball's canonical execution records.
4. Each converter needs a version-pinned schema compatibility fixture suite.
5. Converter-owned callbacks that do not receive a stable framework call ID, including the
   current Vercel AI SDK callback shape, need an explicit cross-invocation retry-correlation
   contract before their mutation quickstarts are release-ready.
## 9. Normative references

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [MCP tools, names, schemas, and annotations (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP Tasks (2025-11-25, experimental)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [Anthropic client tool definitions](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI generated API type for function-name constraints](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py)
- [Vercel AI SDK `tool()`](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool)
