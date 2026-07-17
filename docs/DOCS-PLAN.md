# eyeball public docs plan

Status: proposed  
Platform: Mintlify  
Audience: developers building production AI agents  
North star: a developer completes a real tool call in less than five minutes

## 1. Docs philosophy

The documentation is a product surface, not a support appendix. For a DX-led platform,
the docs must prove the core promise faster and more reliably than a landing page can.

### North-star experience

- Measure time-to-first-tool-call from opening a quickstart to a successful execution whose
  result is returned to the model loop.
- The target is under five minutes on a clean machine with only Node.js, an eyeball API key,
  and an LLM-provider key.
- No quickstart may require creating a Gmail, Slack, Twilio, CRM, or other third-party app.
- Every quickstart defaults to mock mode and uses `eyeball-mocks` through the normal SDK,
  schemas, executor, error contract, and framework converter.
- In hosted quickstarts, `mock: true` selects Eyeball's dedicated project-scoped mock executor;
  it is client endpoint configuration, never an `ExecuteRequest` field or per-provider URL.
  Self-hosting pages instead start `mockhouse` and configure the local executor's trusted
  manifest overrides.
- Mock mode is not a static response pasted into the docs. It exercises validation,
  canonical tool naming, allowlists, execution records, and normalized errors.
- Label this advantage plainly: “Try authenticated agent tools without signing up for the
  provider.” It is a genuine product differentiator.
- Keep every framework quickstart below 30 lines of application code, excluding install
  commands and comments.
- Make the voice-agent demo the showcase: it demonstrates auth composition, async execution,
  child tool calls, event streaming, transcripts, and mocks in one memorable flow.

### Page contract

Every page follows the same reading order:

1. A one-sentence outcome: what the developer will have working.
2. A copyable, tested code example above the first conceptual explanation.
3. The expected output, including execution IDs and status where relevant.
4. Only then, the mental model and details needed to modify the example.
5. A “Next” action that advances a real build, never a generic related-links list.

Reference pages begin with the smallest valid request and response. Concept pages begin with
a runnable example that exposes the concept. Error pages begin with a failing call and its
fixed version. No page opens with positioning copy.

### Quality gates

- All snippets compile and run in CI against the released SDK and catalog version.
- Quickstarts run from empty fixture projects in mock mode on every docs change.
- The five framework quickstarts share one behavior contract and expected canonical result.
- Links, anchors, OpenAPI examples, generated schemas, and code tabs fail CI when stale.
- Track median and p90 time-to-first-tool-call, quickstart completion, copy/run failures,
  search exits, and the first page viewed after an error-code search.
- Treat a broken quickstart as a release blocker for the SDK or catalog that broke it.

## 2. Site structure

The checked-in Mintlify configuration should use the following navigation shape. The
`$generated` entries are expanded by the docs build into ordinary Mintlify page paths; they
are shown here as build-time notation, not a Mintlify runtime feature.

```jsonc
{
  "navigation": [
    { "group": "Getting Started", "pages": [
      "index", "getting-started/quickstart",
      { "group": "Framework quickstarts", "pages": [
        "getting-started/anthropic-sdk", "getting-started/openai",
        "getting-started/vercel-ai-sdk", "getting-started/langchain",
        "getting-started/mcp"
      ]},
      "getting-started/from-mocks-to-live",
      "getting-started/connect-your-first-account"
    ]},
    { "group": "Concepts", "pages": [
      "concepts/projects", "concepts/toolkits-and-canonical-tools",
      "concepts/tool-discovery-and-search", "concepts/connected-accounts-and-auth",
      "concepts/executions-sync-async", "concepts/idempotency-and-retries",
      "concepts/error-handling", "concepts/catalog-and-versioning"
    ]},
    { "group": "Capability Guides", "pages": [
      "capabilities/email", "capabilities/calendar-scheduling",
      "capabilities/messaging-chat", "capabilities/voice-agents", "capabilities/sms",
      "capabilities/crm", "capabilities/erp-accounting", "capabilities/social-media-data",
      "capabilities/social-media-publishing", "capabilities/file-storage-docs",
      "capabilities/spreadsheets-databases", "capabilities/project-management-dev-tools",
      "capabilities/payments-billing", "capabilities/ecommerce",
      "capabilities/customer-support", "capabilities/web-search-scraping",
      "capabilities/hr-recruiting", "capabilities/marketing-ads",
      "capabilities/sign-forms", "capabilities/ai-media-utilities"
    ]},
    { "group": "SDK Reference", "pages": [
      "sdk/typescript/client", "sdk/typescript/tools-get", "sdk/typescript/tools-search",
      "sdk/typescript/tools-execute", "sdk/typescript/connections",
      "sdk/typescript/executions", "sdk/typescript/errors", "sdk/python/client",
      "sdk/python/tools", "sdk/python/connections", "sdk/python/executions"
    ]},
    { "group": "Toolkit Reference", "pages": [
      "toolkits/index", "toolkits/choose-a-toolkit",
      { "$generated": "toolkits/generated/navigation.json" }
    ]},
    { "group": "API Reference", "pages": [
      "api/overview", "api/authentication",
      { "openapi": "execution-api", "pages": [
        "api/executions/execute", "api/executions/get-execution"
      ]},
      { "openapi": "connections-api", "pages": [
        "api/connections/create-connect-link", "api/connections/list-connections",
        "api/connections/get-connection", "api/connections/delete-connection"
      ]},
      "api/webhooks", "api/idempotency", "api/errors"
    ]},
    { "group": "Testing with mocks", "pages": [
      "mocks/overview", "mocks/quickstart", "mocks/fixtures-and-scenarios",
      "mocks/assert-tool-calls", "mocks/normalized-failures", "mocks/voice-sessions",
      "mocks/ci"
    ]},
    { "group": "Self-hosting", "pages": [
      "self-hosting/overview", "self-hosting/local-quickstart",
      "self-hosting/architecture", "self-hosting/credential-provider",
      "self-hosting/mcp-gateway", "self-hosting/executor", "self-hosting/voice-worker",
      "self-hosting/cloud-boundary", "self-hosting/operations-and-upgrades"
    ]},
    { "group": "Changelog", "pages": [
      "changelog/index", "changelog/sdk-api", "changelog/catalog",
      "changelog/deprecations"
    ]}
  ]
}
```

### Toolkit navigation at launch

The generated toolkit branch contains one page per manifest, grouped by capability. A
multi-capability toolkit has one page with capability sections and one navigation entry.

The catalog 1.0 launch expansion includes all 34 P0 providers: Gmail, Microsoft Outlook, Google Calendar,
Slack, Discord, Telegram, WhatsApp Business, Twilio, LiveKit, Pipecat, ElevenLabs, Deepgram,
HubSpot, Odoo, QuickBooks, Instagram Data, TikTok Data, YouTube Data, X Data, LinkedIn Data,
Reddit Data, Twitch Data, Snapchat Data, Google Drive, Google Sheets, Airtable, Notion, GitHub,
Linear, Stripe, Shopify, Zendesk, Firecrawl, and Serper. Catalog 1.1 adds the P0 native
`voice-agents` toolkit; it is not part of the 34-provider catalog 1.0 count.

Each toolkit page must show, in this order: a minimal tool call, supported canonical tools,
input and output schemas, auth class and scopes/fields, provider-specific extensions,
sync/async annotations, examples, mock support, limitations, and catalog/tool versions.

### Editorial capability guides

Capability guides are hand-authored task guides, not schema dumps. They teach cross-provider
tasks and link to generated truth: email send/search/reply; messaging threads and reactions;
social-data semantics and limits; CRM/ERP IDs, pagination, and write safety; and the flagship
voice tutorial in Section 4.

### Self-hosting story

State the open-core boundary before deployment steps.

- Local: core validators, converters, catalog, bridge, executor, MCP gateway,
  `eyeball-mocks`, static/env credentials restricted to one project/user pair, and the
  separately deployed voice worker.
- Cloud-required for production managed auth: encrypted multi-user vault, hosted OAuth/connect,
  refresh, and connected accounts. A local executor may call this `CredentialProvider`.
- Never present the toy provider as multi-tenant auth. Document data flow, outbound calls,
  version compatibility, and behavior when cloud credential resolution is unavailable.

## 3. The five quickstarts

All five quickstarts produce the same observable result: an agent calls
`gmail.send_email` for `demo_user`, mock mode returns a canonical successful execution, and
the model receives the tool result. The only changing layer is the framework adapter.

Common skeleton: install; export `EYEBALL_API_KEY` and the model key; create a mock client;
call `tools.get`; pass converted tools to the model; provide a stable RFC 001
`Idempotency-Key` for the mutating email call; dispatch through `tools.execute`; print the
final response; link to “From mocks to live.”

The documented SDK bundle exposes native descriptors, immutable canonical definitions, and
RFC 001's `nameMap`. Samples map `gmail__send_email` back to `gmail.send_email`; they never
parse an untrusted model name by replacing separators.
On success, framework loops return only the canonical `run.output` to the model; on failure,
they return the normalized `run.error` with the framework's error signal. The surrounding
application retains `executionId`, versions, status, and latency for observability instead of
injecting that execution envelope into the canonical tool result.
The positional `tools.execute(tool, options)` SDK overload constructs RFC 001's exact
`{ tool, userId, connectionId?, input, mode }` request body. The API key supplies `projectId`;
the SDK never adds it to that body. The idempotency key is an HTTP header, not an
`ExecuteRequest` field. Direct SDK calls accept an explicit key, Anthropic/OpenAI dispatch
helpers derive it from the stable framework call ID, and MCP derives it from the session and
JSON-RPC request ID. Converter callbacks without a stable call ID remain an open decision in
`SPEC.md` §9, so only those mutation templates are blocked.

### Anthropic SDK — draft template

Install `@anthropic-ai/sdk` and `@eyeball/sdk`, set `ANTHROPIC_API_KEY` and
`EYEBALL_API_KEY`, then run this application. The target TypeScript block remains below 30
lines and derives the required mutation key from Anthropic's stable tool-use ID.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Eyeball } from "@eyeball/sdk";

const claude = new Anthropic();
const eb = new Eyeball({ apiKey: process.env.EYEBALL_API_KEY!, mock: true });
const userId = "demo_user";
const bundle = await eb.tools.get({ userId, toolkits: ["gmail"], format: "anthropic" });

let messages: Anthropic.MessageParam[] = [{
  role: "user", content: "Email sam@example.com: Dinner is at 7pm."
}];
while (true) {
  const reply = await claude.messages.create({
    model: "claude-sonnet-4-6", max_tokens: 512, tools: bundle.tools, messages
  });
  messages.push({ role: "assistant", content: reply.content });
  const calls = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (reply.stop_reason !== "tool_use") { console.log(reply.content); break; }
  const results = await Promise.all(calls.map(async (call) => {
    const tool = bundle.nameMap.wireToCanonical[call.name];
    const run = await eb.tools.execute(tool, { userId, input: call.input, mode: "sync",
      idempotencyKey: `anthropic:${call.id}` });
    return { type: "tool_result" as const, tool_use_id: call.id,
      content: JSON.stringify(run.status === "succeeded" ? run.output : run.error),
      is_error: run.status === "failed" };
  }));
  messages.push({ role: "user", content: results });
}
```

The page shows the mock execution under the code, including `executionId`, canonical tool
name, catalog/tool versions, `status: "succeeded"`, and normalized output. A final callout
explains that mock mode removes Gmail OAuth, not Anthropic or eyeball API authentication.

### OpenAI

1. Install `openai` and `@eyeball/sdk`; export `OPENAI_API_KEY` and `EYEBALL_API_KEY`.
2. Create the mock client and request `format: "openai"` for the Gmail toolkit.
3. Pass `bundle.tools` to the Responses/agent loop.
4. For each function call, look up the canonical name in `bundle.nameMap.wireToCanonical`.
5. Call `eb.tools.execute` with the canonical name, scoped user, input, sync mode, and an
   idempotency key formed from the `openai:` prefix plus `call.id`; submit canonical output or
   the normalized error as
   function-call output until the model returns text.

The code shape mirrors the Anthropic template and stays below 30 lines by using one small
`while` loop. Do not hide execution in a framework-specific convenience until the manual
dispatch path is visible once.

### Vercel AI SDK

1. Install `ai`, the chosen model-provider package, and `@eyeball/sdk`; export both keys.
2. Request Gmail with `format: "ai-sdk"` from the mock client.
3. Pass the returned tool set to `generateText` or `streamText` with bounded step execution.
4. The converter's tool `execute` wrapper maps the wire name and delegates to
   `eb.tools.execute`. It currently receives a fresh SDK UUID per callback invocation; do not
   publish the mutation template until the framework exposes, or the companion contract
   defines, stable cross-invocation correlation.
5. Print the final text and link to streaming UI patterns after the first success.

The sample stays below 20 lines because the AI SDK owns the multi-step loop, but the page
still expands one execution trace so readers can see where eyeball runs.

### LangChain — draft pending converter contract

1. Install `@langchain/core`, the selected LangChain model package, and `@eyeball/sdk`.
2. Export the two keys and request Gmail with `format: "langchain"` in mock mode.
3. Bind `bundle.tools` to the chat model and create the minimal tool-calling graph/loop.
4. Each returned LangChain tool delegates to `eb.tools.execute` with `demo_user` scope and
   unwraps canonical output or a normalized error for the model.
5. Invoke with the email prompt, print the final message, and show the execution trace.

Keep the first example to one model node and one tool node. Agents, memory, persistence, and
LangGraph deployment belong on a follow-up page, not in time-to-first-tool-call.
Do not publish this quickstart until RFC 001 defines a version-pinned LangChain descriptor,
schema/name-map conversion, invocation, error behavior, and mutation-idempotency mapping.

### MCP

1. Install/start the eyeball MCP gateway or add the hosted project URL to an MCP client.
2. Set the project API key and select mock mode in the server configuration.
3. The gateway performs the equivalent of `tools.get({ format: "mcp" })` and exposes
   canonical dotted names through `tools/list`.
4. The MCP host runs the agent loop; `tools/call` dispatches through the normal executor.
5. Ask the host to send the email, then inspect canonical `structuredContent` and the
   `dev.eyeball/execution` result metadata containing its execution ID.

The page includes one minimal server configuration and one prompt, together below 30 lines.
It explains that async-only tools require negotiated MCP Tasks support; otherwise they are
omitted from `tools/list` and remain available through REST/SDK execution. One logical
`tools/call` and its transport retries reuse the session-scoped JSON-RPC request ID as the
stable RFC 001 idempotency key; cross-session workflows can supply the namespaced metadata
override documented by RFC 001.

## 4. Voice-agent showcase page

Title: “Build a restaurant reservation phone agent.” Promise: create and test a complete
phone agent in about 50 lines without a Twilio, Deepgram, ElevenLabs, Gmail, or Google
Calendar account.

The page pins catalog 1.1 because `voice-agents` is additive to the frozen 1.0 provider catalog.

The tutorial flow is:

1. Install `@eyeball/sdk`, `@eyeball/mock-kit`, and the Pipecat mock export; start the
   scripted restaurant caller fixture.
2. Create an eyeball client in mock mode.
3. Execute `voice-agents.create_voice_agent` with a stable idempotency key, a PSTN draft,
   host prompt, and the allowlist `google-calendar.create_event` plus `gmail.send_email`.
4. Set duration, handoff, webhook, recording/consent, and DTMF-redaction policy; keep the mock
   scenario outside `VoiceAgentDefinition`.
5. Execute `voice-agents.start_agent_call` asynchronously with a second stable idempotency
   key for the returned immutable revision.
6. Stream ordered lifecycle, transcript, tool-call, and result events with an SDK helper over
   `voice-agents.get_agent_session` using `afterSequence`.
7. Fetch the final transcript artifact and assert the two child execution IDs.
8. For live mode, connect transport/speech and calendar/email accounts, then disable mocks.

The executable reference behind this page is `apps/mcp-gateway/demo/restaurant.ts`. Its
`runVoiceSessionDriver` worker uses the Pipecat event sequence for idempotency, reserves each
durable `tool_call` execution ID at the trusted engine boundary, and verifies the same IDs in
the final transcript. The public RFC 001 execute payload remains unchanged.

The page should embed a transcript component whose tool events render as chips:

```mdx
<Transcript speaker="Diner">Tomorrow at 7, a table for four. Email sam@example.com.</Transcript>
<Transcript speaker="Agent">I’ll reserve it and send your confirmation.</Transcript>
<ToolCallChip tool="google-calendar.create_event" status="succeeded" executionId="exe_cal_01" />
<ToolCallChip tool="gmail.send_email" status="succeeded" executionId="exe_mail_01" />
<Transcript speaker="Agent">You’re booked for four tomorrow at 7. The email is sent.</Transcript>
```

Keep tool input collapsed; reveal canonical input/output on click; link execution IDs to the
execution concept. Use the real allowlist, schemas, executor, events, and transcript shape.

## 5. Generation pipeline

Provider manifests are the source of truth for toolkit reference. Hand-edited toolkit MDX is
forbidden because it will drift from shipped tools, schemas, auth, scopes, and versions.

```text
provider manifests + canonical capability contracts
  -> catalog compiler and conformance validation
  -> versioned catalog.json
  -> docs renderer
  -> generated toolkit MDX + generated navigation fragment
  -> Mintlify build, link check, snippet tests, preview
```

### Release workflow

1. A catalog release validates provider slugs, implemented subsets, schema versions,
   restricted-name collisions, auth requirements, scopes, annotations, and versions.
2. CI publishes an immutable, versioned catalog JSON artifact.
3. The docs job renders one deterministic MDX page per toolkit from that artifact.
4. The renderer emits frontmatter, tools, JSON Schemas, auth, extensions, examples, mock
   status, versions, and capability-grouped `toolkits/generated/navigation.json`.
5. CI compares generated output with the repository. Diffs fail with the regeneration command;
   generated files carry a “do not edit” banner and catalog checksum.
6. Contract tests execute each generated minimal example against `eyeball-mocks` when a
   fixture exists. Missing P0 fixtures fail the catalog release.
7. Mintlify preview builds run link, anchor, schema-render, and mobile-layout checks.
8. The docs deployment is promoted with the catalog release, never independently behind it.

Capability guides import tool names and schemas from generated data. Separately, the
control-plane/execution OpenAPI document generates endpoint pages and request examples;
guides may surround them but must not fork endpoint truth into hand-written tables.

## 6. Voice and tone

- Developer-to-developer, terse, code-first, and specific.
- Use lowercase `eyeball` in prose and exact package/API casing in code.
- State prerequisites, side effects, auth scope, and sync/async behavior before execution.
- Prefer “Run this” and “You get” over “simply,” “seamlessly,” or product superlatives.
- Zero marketing fluff inside docs. The evidence is the short working path and visible result.
- Never hide provider limitations or imply an unsupported canonical tool is emulated.
- Use one term consistently: project, toolkit, canonical tool, connected account, execution.
- Show canonical dotted names in prose; explain restricted wire names only at framework edges.
- Treat copy, code, output, and error remediation as one tested unit.

Errors are documentation. `api/errors` and `concepts/error-handling` provide stable anchors
for `invalid_input`, `auth_missing`, `auth_expired`, `auth_insufficient_scope`, `not_found`,
`rate_limited`, `provider_unavailable`, `provider_error`, `timeout`, and `not_supported`.

Each anchor includes meaning, retry safety, a failing request/response, exact remediation,
framework handling, relevant links, and sanitized-detail rules. SDK and dashboard errors link
to the same anchors, making every failure a path back to a working call.
