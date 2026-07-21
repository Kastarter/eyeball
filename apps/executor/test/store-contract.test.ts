import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExecutionId,
  createFileId,
  createTriggerEventArrivalId,
  createTriggerSubscriptionId,
  type ExecutionRecord,
  MockCredentialProvider,
  type VoiceAgentDraft,
} from "@eyeball/core";
import {
  InMemoryAgentStore,
  TwilioAdapter,
  VoiceAgentsAdapter,
} from "@eyeball/toolkits";
import { afterAll, expect, it, vi } from "vitest";
import {
  type AppendTriggerEventInput,
  createExecutorApp,
  createExecutorRuntime,
  createJobEnvelope,
  createPgliteStoreBundle,
  createVoiceSessionGrantAuthority,
  executorJobId,
  InMemoryExecutionStore,
  InMemoryFileStore,
  InMemoryJobStore,
  InMemoryTriggerEventStore,
  InMemoryTriggerStateStore,
  InMemoryTriggerSubscriptionStore,
  InMemoryUsageOutboxStore,
  InMemoryWebhookDeliveryStore,
  InMemoryWebhookEndpointStore,
  InMemoryWebhookWorkStore,
  noopLogger,
  type PgliteStoreBundle,
  recoverExecutorJobs,
  TriggerEventPersistenceError,
  webhookEndpointGroupKey,
} from "../src/index.js";
import {
  registerStoreContractSuite,
  type StoreContractStores,
} from "./helpers/store-contract-suite.js";

let pgliteBundlePromise: Promise<PgliteStoreBundle> | undefined;

const contractAgentDraft: VoiceAgentDraft = {
  name: "Durable contract agent",
  systemPrompt: "Handle the durable contract call.",
  llm: { model: "model:fixture:durable-contract" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_contract" },
    stt: { provider: "deepgram", model: "nova-3" },
  },
  transport: "pstn:twilio",
  tools: [],
  guardrails: {
    maxDurationSeconds: 300,
    handoffToHuman: { enabled: false },
  },
  webhooks: { endpointIds: [], transcript: true, events: [] },
  recordingPolicy: {
    mode: "audio_and_transcript",
    consent: "agent_announcement",
    retentionDays: 7,
    redactDtmf: true,
  },
};

function pgliteStores(): Promise<PgliteStoreBundle> {
  pgliteBundlePromise ??= createPgliteStoreBundle();
  return pgliteBundlePromise;
}

function errorChainText(error: unknown): string {
  const seen = new Set<Error>();
  const values: string[] = [];
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "cause") continue;
      const value = Reflect.get(current, key) as unknown;
      if (typeof value === "string") values.push(value);
      if (value instanceof Uint8Array) values.push([...value].join(","));
      if (Array.isArray(value)) values.push(value.map(String).join(","));
    }
    current = current.cause;
  }
  return values.join("\n");
}

afterAll(async () => {
  if (pgliteBundlePromise !== undefined) {
    await (await pgliteBundlePromise).close();
  }
});

registerStoreContractSuite([
  {
    name: "in-memory",
    stores: async (): Promise<StoreContractStores> => {
      const webhookDeliveryStore = new InMemoryWebhookDeliveryStore();
      const jobStore = new InMemoryJobStore();
      return {
        agentStore: new InMemoryAgentStore(),
        executionStore: new InMemoryExecutionStore(),
        fileStore: new InMemoryFileStore(),
        webhookEndpointStore: new InMemoryWebhookEndpointStore(),
        webhookDeliveryStore,
        webhookWorkStore: new InMemoryWebhookWorkStore(
          webhookDeliveryStore,
          jobStore,
        ),
        triggerSubscriptionStore: new InMemoryTriggerSubscriptionStore(),
        triggerEventStore: new InMemoryTriggerEventStore(),
        triggerStateStore: new InMemoryTriggerStateStore(),
        usageOutboxStore: new InMemoryUsageOutboxStore(),
        jobStore,
      };
    },
  },
  {
    name: "PGlite",
    stores: pgliteStores,
  },
]);

it("keeps zero-config runtime stores in memory", async () => {
  const runtime = await createExecutorRuntime({
    env: {},
    credentialProvider: new MockCredentialProvider([]),
  });
  expect(runtime.persistence).toBeUndefined();
  expect(runtime.engine.store).toBeInstanceOf(InMemoryExecutionStore);
  expect(runtime.engine.fileStore).toBeInstanceOf(InMemoryFileStore);
  expect(runtime.engine.webhookDeliverer.endpointStore).toBeInstanceOf(
    InMemoryWebhookEndpointStore,
  );
  expect(runtime.engine.triggerService.stateStore).toBeInstanceOf(
    InMemoryTriggerStateStore,
  );
  expect(runtime.engine.triggerService.eventStore).toBeInstanceOf(
    InMemoryTriggerEventStore,
  );
  expect(runtime.engine.adapters.require("voice-agents")).toBeInstanceOf(
    VoiceAgentsAdapter,
  );
  expect(
    (runtime.engine.adapters.require("voice-agents") as VoiceAgentsAdapter)
      .store,
  ).toBeInstanceOf(InMemoryAgentStore);
  await runtime.close();
});

it("wires every durable store when EYEBALL_DATABASE_URL is set", async () => {
  const bundle = await createPgliteStoreBundle();
  const projectId = "project_durable_wiring";
  const userId = "user_durable_wiring";
  const phoneNumber = "+12025550173";
  const agent = await bundle.agentStore.createAgent(
    projectId,
    contractAgentDraft,
    "2026-07-20T03:00:00.000Z",
  );
  await bundle.agentStore.attachNumber(
    {
      projectId,
      userId,
      agentId: agent.id,
      revision: agent.revision,
      phoneNumber,
      transportConnectionId: "conn_durable_wiring",
    },
    "2026-07-20T03:00:01.000Z",
  );
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([
      {
        match: { projectId, userId, toolkitSlug: "twilio" },
        credential: {
          type: "basic",
          username: "ACdurable",
          password: "fixture:valid",
        },
      },
    ]),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          incoming_phone_numbers: [
            {
              sid: "PNdurable",
              phone_number: phoneNumber,
              friendly_name: "Durable line",
              date_created: "2026-07-20T03:00:00.000Z",
            },
          ],
          next_page_uri: null,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    persistenceFactory: async () => bundle,
  });
  try {
    expect(runtime.persistence).toBe(bundle);
    expect(runtime.engine.store).toBe(bundle.executionStore);
    expect(runtime.engine.fileStore).toBe(bundle.fileStore);
    expect(runtime.engine.webhookDeliverer.endpointStore).toBe(
      bundle.webhookEndpointStore,
    );
    expect(runtime.engine.webhookDeliverer.deliveryStore).toBe(
      bundle.webhookDeliveryStore,
    );
    expect(runtime.engine.triggerService.subscriptionStore).toBe(
      bundle.triggerSubscriptionStore,
    );
    expect(runtime.engine.triggerService.stateStore).toBe(
      bundle.triggerStateStore,
    );
    expect(runtime.engine.triggerService.eventStore).toBe(
      bundle.triggerEventStore,
    );
    expect(
      (runtime.engine.adapters.require("voice-agents") as VoiceAgentsAdapter)
        .store,
    ).toBe(bundle.agentStore);
    expect(runtime.engine.adapters.require("twilio")).toBeInstanceOf(
      TwilioAdapter,
    );
    const inventory = await runtime.engine.execute({
      projectId,
      idempotencyKey: "durable-twilio-inventory",
      request: {
        tool: "twilio.list_numbers",
        userId,
        input: {},
        mode: "sync",
      },
    });
    expect(inventory.response).toMatchObject({
      status: "succeeded",
      output: {
        numbers: [
          {
            phoneNumber,
            bindingStatus: "bound",
            binding: { agentId: agent.id, revision: 1 },
          },
        ],
      },
    });
  } finally {
    await runtime.close();
  }
});

it("migrates the durable voice-agent aggregate with exact revision constraints", async () => {
  const bundle = await pgliteStores();
  const tableNames = [
    "voice_agents",
    "voice_agent_revisions",
    "voice_agent_number_bindings",
    "voice_agent_session_pointers",
    "voice_agent_session_observers",
    "voice_agent_message_receipts",
    "voice_webhook_sources",
  ];
  const columns = await bundle.client.query<{
    table_name: string;
    column_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name = any($1)
      order by table_name, ordinal_position`,
    [tableNames],
  );
  expect(new Set(columns.rows.map(({ table_name }) => table_name))).toEqual(
    new Set(tableNames),
  );
  expect(
    columns.rows
      .filter(({ table_name }) => table_name === "voice_agent_revisions")
      .map(({ column_name }) => column_name),
  ).toEqual(["project_id", "agent_id", "revision", "definition", "created_at"]);

  const constraints = await bundle.client.query<{
    constraint_name: string;
  }>(
    `select con.conname as constraint_name
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
      where rel.relname = any($1)`,
    [tableNames],
  );
  const names = new Set(
    constraints.rows.map(({ constraint_name }) => constraint_name),
  );
  expect(names.has("voice_agent_revisions_agent_fk")).toBe(true);
  expect(names.has("voice_agent_number_bindings_revision_fk")).toBe(true);
  expect(names.has("voice_agent_session_pointers_revision_fk")).toBe(true);
  expect(names.has("voice_agent_session_observers_pointer_fk")).toBe(true);
  expect(names.has("voice_webhook_sources_session_fk")).toBe(true);
  expect(
    [...names].some((name) =>
      name.startsWith(
        "voice_agent_message_receipts_project_id_user_id_session_id_",
      ),
    ),
  ).toBe(true);

  const indexes = await bundle.client.query<{ indexname: string }>(
    `select indexname
       from pg_indexes
      where schemaname = 'public'
        and tablename = any($1)`,
    [tableNames],
  );
  const indexNames = new Set(indexes.rows.map(({ indexname }) => indexname));
  expect(indexNames.has("voice_agents_project_created_idx")).toBe(true);
  expect(indexNames.has("voice_agent_number_bindings_binding_id_uidx")).toBe(
    true,
  );
  expect(indexNames.has("voice_agent_session_pointers_scope_created_idx")).toBe(
    true,
  );
  expect(indexNames.has("voice_agent_session_pointers_grant_id_unique")).toBe(
    true,
  );
  expect(indexNames.has("voice_agent_session_observers_recovery_idx")).toBe(
    true,
  );
  expect(indexNames.has("voice_webhook_sources_worker_sequence_uidx")).toBe(
    true,
  );
  expect(
    names.has("voice_agent_session_pointers_grant_identity_complete"),
  ).toBe(true);
  expect(
    names.has("voice_agent_session_pointers_revocation_requires_grant"),
  ).toBe(true);
});

it("migrates the private execution replay-observation sidecar", async () => {
  const bundle = await pgliteStores();
  const columns = await bundle.client.query<{
    column_name: string;
    is_nullable: string;
    data_type: string;
  }>(
    `select column_name, is_nullable, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'executions'
        and column_name = 'replay_observed_at'`,
  );
  expect(columns.rows).toEqual([
    {
      column_name: "replay_observed_at",
      is_nullable: "YES",
      data_type: "timestamp with time zone",
    },
  ]);
});

it("migrates the redacted trigger-event table with only allowlisted columns", async () => {
  const bundle = await pgliteStores();
  const columns = await bundle.client.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = 'trigger_events'
      order by ordinal_position`,
  );
  expect(columns.rows.map(({ column_name }) => column_name)).toEqual([
    "sequence",
    "arrival_id",
    "project_id",
    "event_id",
    "subscription_id",
    "trigger",
    "delivery_mode",
    "received_at",
    "occurred_at",
    "dedup_status",
    "delivery_admission_status",
    "requested_webhook_endpoint_ids",
    "expires_at",
  ]);
  expect(
    columns.rows.some(({ column_name }) =>
      /payload|body|provider.*event|url|secret|credential|token|filter|cursor|header|signature/iu.test(
        column_name,
      ),
    ),
  ).toBe(false);
  const indexes = await bundle.client.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public'
        and tablename in ('trigger_events', 'webhook_deliveries')`,
  );
  const names = new Set(indexes.rows.map(({ indexname }) => indexname));
  for (const name of [
    "trigger_events_project_received_idx",
    "trigger_events_project_subscription_received_idx",
    "trigger_events_project_trigger_received_idx",
    "trigger_events_expiry_idx",
    "trigger_events_project_event_idx",
    "webhook_deliveries_project_event_idx",
  ]) {
    expect(names.has(name)).toBe(true);
  }
  const checks = await bundle.client.query<{ conname: string }>(
    `select conname
       from pg_constraint
      where conrelid = 'trigger_events'::regclass
        and contype = 'c'`,
  );
  const checkNames = new Set(checks.rows.map(({ conname }) => conname));
  for (const name of [
    "trigger_events_delivery_mode_check",
    "trigger_events_dedup_status_check",
    "trigger_events_delivery_admission_status_check",
    "trigger_events_status_consistency_check",
    "trigger_events_requested_endpoint_ids_array_check",
    "trigger_events_expiry_after_received_check",
  ]) {
    expect(checkNames.has(name)).toBe(true);
  }
});

it("never persists unsafe cast-only trigger event fields in raw Postgres rows", async () => {
  const bundle = await pgliteStores();
  const projectId = "project_trigger_event_raw_privacy";
  const arrivalId = createTriggerEventArrivalId("raw_privacy");
  const unsafe = {
    arrivalId,
    eventId: "evt_trigger_raw_privacy",
    subscriptionId: createTriggerSubscriptionId("raw_privacy"),
    trigger: "slack.message_received",
    deliveryMode: "push",
    receivedAt: "2026-07-21T12:00:00.000Z",
    occurredAt: "2026-07-21T11:59:59.000Z",
    dedupStatus: "accepted",
    deliveryAdmissionStatus: "admitted",
    requestedWebhookEndpointIds: ["whe_raw_privacy"],
    expiresAt: "2026-07-28T12:00:00.000Z",
    payload: { sentinel: "payload_must_not_persist" },
    providerEventId: "provider_event_must_not_persist",
    pushSecret: "push_secret_must_not_persist",
    credentials: { accessToken: "credential_must_not_persist" },
  } as AppendTriggerEventInput;
  await bundle.triggerEventStore.append(projectId, unsafe);
  const row = await bundle.client.query<Record<string, unknown>>(
    `select * from trigger_events where arrival_id = $1`,
    [arrivalId],
  );
  const serialized = JSON.stringify(row.rows);
  for (const sentinel of [
    "payload_must_not_persist",
    "provider_event_must_not_persist",
    "push_secret_must_not_persist",
    "credential_must_not_persist",
  ]) {
    expect(serialized).not.toContain(sentinel);
  }
});

it("keeps trigger-event persistence failures metadata-safe", async () => {
  const bundle = await createPgliteStoreBundle();
  const payloadSentinel = "trigger-event-payload-error-sentinel";
  const secretSentinel = "trigger-event-secret-error-sentinel";
  try {
    await bundle.client.exec("drop table trigger_events");
    let captured: unknown;
    try {
      await bundle.triggerEventStore.append("project_trigger_event_failure", {
        arrivalId: createTriggerEventArrivalId("persistence_failure"),
        eventId: "evt_trigger_persistence_failure",
        subscriptionId: createTriggerSubscriptionId("persistence_failure"),
        trigger: "slack.message_received",
        deliveryMode: "push",
        receivedAt: "2026-07-21T12:00:00.000Z",
        occurredAt: "2026-07-21T11:59:59.000Z",
        dedupStatus: "accepted",
        deliveryAdmissionStatus: "admitted",
        requestedWebhookEndpointIds: ["whe_persistence_failure"],
        expiresAt: "2026-07-28T12:00:00.000Z",
        payload: { sentinel: payloadSentinel },
        pushSecret: secretSentinel,
      } as AppendTriggerEventInput);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(TriggerEventPersistenceError);
    const safeError = captured as Error;
    expect(safeError.message).toBe("Trigger event persistence failed.");
    expect(safeError.cause).toBeUndefined();
    expect(errorChainText(safeError)).not.toContain(payloadSentinel);
    expect(errorChainText(safeError)).not.toContain(secretSentinel);
  } finally {
    await bundle.close();
  }
});

it("reconstructs trigger-event history until exact expiry", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "eyeball-trigger-event-restart-"),
  );
  const projectId = "project_trigger_event_restart";
  const arrivalId = createTriggerEventArrivalId("restart_history");
  let first: PgliteStoreBundle | undefined;
  let restored: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    await first.triggerEventStore.append(projectId, {
      arrivalId,
      eventId: "evt_trigger_restart_history",
      subscriptionId: createTriggerSubscriptionId("restart_history"),
      trigger: "gmail.email_received",
      deliveryMode: "polling",
      receivedAt: "2026-07-21T12:00:00.000Z",
      occurredAt: "2026-07-21T11:59:59.000Z",
      dedupStatus: "accepted",
      deliveryAdmissionStatus: "admitted",
      requestedWebhookEndpointIds: ["whe_restart_history"],
      expiresAt: "2026-07-28T12:00:00.000Z",
    });
    await first.close();
    first = undefined;

    restored = await createPgliteStoreBundle({ dataDir: directory });
    await expect(
      restored.triggerEventStore.list(projectId, {
        now: "2026-07-28T11:59:59.999Z",
        limit: 10,
      }),
    ).resolves.toMatchObject({ triggerEvents: [{ arrivalId }] });
    await expect(
      restored.triggerEventStore.list(projectId, {
        now: "2026-07-28T12:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toEqual({ triggerEvents: [] });
    await expect(
      restored.triggerEventStore.sweepExpired({
        now: "2026-07-28T12:00:00.000Z",
        limit: 100,
      }),
    ).resolves.toBe(1);
    const row = await restored.client.query<{ present: boolean }>(
      "select exists(select 1 from trigger_events where arrival_id = $1) as present",
      [arrivalId],
    );
    expect(row.rows[0]?.present).toBe(false);
  } finally {
    await first?.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves active and revoked grant state across PGlite reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-grant-restart-"));
  const secret = "g".repeat(32);
  const now = new Date("2026-07-21T08:00:00.000Z");
  const projectId = "project_grant_restart";
  const userId = "user_grant_restart";
  const activeSession = "session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const revokedSession = "session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let first: PgliteStoreBundle | undefined;
  let restored: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    const agent = await first.agentStore.createAgent(
      projectId,
      contractAgentDraft,
      now.toISOString(),
    );
    const firstAuthority = createVoiceSessionGrantAuthority({
      secret,
      store: first.agentStore,
      clock: { now: () => now },
    });
    const active = await firstAuthority.issuer.issue({
      projectId,
      userId,
      sessionId: activeSession,
      maxDurationSeconds: 300,
      allowedTools: [],
    });
    const revoked = await firstAuthority.issuer.issue({
      projectId,
      userId,
      sessionId: revokedSession,
      maxDurationSeconds: 300,
      allowedTools: [],
    });
    for (const [sessionId, issued] of [
      [activeSession, active],
      [revokedSession, revoked],
    ] as const) {
      await first.agentStore.rememberSession({
        sessionId,
        projectId,
        userId,
        agentId: agent.id,
        agentRevision: agent.revision,
        callId: `call_${sessionId}`,
        createdAt: now.toISOString(),
        grantId: issued.grantId,
        grantExpiresAt: issued.expiresAt,
      });
    }
    await first.agentStore.revokeSessionGrant({
      projectId,
      userId,
      sessionId: revokedSession,
      grantId: revoked.grantId,
      revokedAt: now.toISOString(),
    });
    await first.close();
    first = undefined;

    restored = await createPgliteStoreBundle({ dataDir: directory });
    const restoredAuthority = createVoiceSessionGrantAuthority({
      secret,
      store: restored.agentStore,
      clock: { now: () => now },
    });
    expect((await restoredAuthority.verifier.verify(active.token)).status).toBe(
      "valid",
    );
    expect(await restoredAuthority.verifier.verify(revoked.token)).toEqual({
      status: "expired",
    });
    const rows = await restored.client.query(
      "select * from voice_agent_session_pointers where project_id = $1",
      [projectId],
    );
    const persisted = JSON.stringify(rows.rows);
    expect(persisted).not.toContain(active.token);
    expect(persisted).not.toContain(revoked.token);
    expect(persisted).not.toContain(secret);

    const processLocalAuthority = createVoiceSessionGrantAuthority({
      secret,
      store: new InMemoryAgentStore(),
      clock: { now: () => now },
    });
    expect(await processLocalAuthority.verifier.verify(active.token)).toEqual({
      status: "expired",
    });
  } finally {
    await first?.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reconstructs durable agents, pinned metadata, and receipts after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-agent-restart-"));
  const projectId = "project_agent_restart";
  const userId = "user_agent_restart";
  const phoneNumber = "+12025550174";
  let first: PgliteStoreBundle | undefined;
  let restored: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    const revision1 = await first.agentStore.createAgent(
      projectId,
      contractAgentDraft,
      "2026-07-20T04:00:00.000Z",
    );
    await first.agentStore.updateAgent(
      projectId,
      revision1.id,
      1,
      { ...contractAgentDraft, name: "Durable contract agent v2" },
      "2026-07-20T04:00:01.000Z",
    );
    const binding = await first.agentStore.attachNumber(
      {
        projectId,
        userId,
        agentId: revision1.id,
        revision: 1,
        phoneNumber,
        transportConnectionId: "conn_agent_restart",
      },
      "2026-07-20T04:00:02.000Z",
    );
    const pointer = {
      sessionId: "session_agent_restart",
      projectId,
      userId,
      agentId: revision1.id,
      agentRevision: 1,
      callId: "call_agent_restart",
      createdAt: "2026-07-20T04:00:03.000Z",
    };
    await first.agentStore.rememberSession(pointer);
    const receipt = {
      sessionId: pointer.sessionId,
      clientMessageId: "client_agent_restart",
      message: "Persist this turn.",
      userMessageId: "message_agent_restart",
      assistantMessage: "Persisted.",
    };
    await first.agentStore.rememberMessage(projectId, userId, receipt);
    await first.close();
    first = undefined;

    restored = await createPgliteStoreBundle({ dataDir: directory });
    const runtime = await createExecutorRuntime({
      env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
      credentialProvider: new MockCredentialProvider([]),
      persistenceFactory: async () => restored as PgliteStoreBundle,
    });
    try {
      const adapter = runtime.engine.adapters.require(
        "voice-agents",
      ) as VoiceAgentsAdapter;
      expect(adapter.store).toBe(restored.agentStore);
      await expect(
        adapter.store.getAgent(projectId, revision1.id),
      ).resolves.toMatchObject({
        revision: 2,
        name: "Durable contract agent v2",
      });
      await expect(
        adapter.store.getAgent(projectId, revision1.id, 1),
      ).resolves.toEqual(revision1);
      await expect(
        adapter.store.getNumberBinding(projectId, phoneNumber),
      ).resolves.toEqual(binding);
      await expect(
        adapter.store.getSession(projectId, userId, pointer.sessionId),
      ).resolves.toEqual(pointer);
      await expect(
        adapter.store.getMessage(
          projectId,
          userId,
          receipt.sessionId,
          receipt.clientMessageId,
        ),
      ).resolves.toEqual(receipt);

      const anotherAgent = await adapter.store.createAgent(
        projectId,
        { ...contractAgentDraft, name: "Another durable agent" },
        "2026-07-20T04:00:04.000Z",
      );
      const anotherBinding = await adapter.store.attachNumber(
        {
          projectId,
          userId,
          agentId: anotherAgent.id,
          revision: 1,
          phoneNumber: "+12025550175",
          transportConnectionId: "conn_agent_restart",
        },
        "2026-07-20T04:00:05.000Z",
      );
      expect(anotherAgent.id).not.toBe(revision1.id);
      expect(anotherBinding.bindingId).not.toBe(binding.bindingId);
    } finally {
      await runtime.close();
      restored = undefined;
    }
  } finally {
    await first?.close();
    await restored?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not expose voice-agent data in unexpected persistence failures", async () => {
  const bundle = await createPgliteStoreBundle();
  const sentinel = "agent-prompt-plaintext-sentinel";
  try {
    await bundle.client.exec("drop table voice_agents cascade");
    let captured: unknown;
    try {
      await bundle.agentStore.getAgent("project_failure", sentinel);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    const safeError = captured as Error;
    expect(safeError.message).toBe("Voice-agent persistence failed.");
    expect(safeError.cause).toBeUndefined();
    expect(errorChainText(safeError)).not.toContain(sentinel);
  } finally {
    await bundle.close();
  }
});

it("sweeps expired durable files in fixed-clock batches before startup", async () => {
  const bundle = await createPgliteStoreBundle();
  const sweep = vi
    .spyOn(bundle.fileStore, "sweepExpired")
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce(2);
  const now = new Date("2026-07-18T08:30:00.000Z");
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now) },
  });
  try {
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenNthCalledWith(1, {
      limit: 100,
      now: now.toISOString(),
    });
    expect(sweep).toHaveBeenNthCalledWith(2, {
      limit: 100,
      now: now.toISOString(),
    });
  } finally {
    await runtime.close();
  }
});

it("sweeps expired durable trigger events in fixed-clock batches before startup", async () => {
  const bundle = await createPgliteStoreBundle();
  const sweep = vi
    .spyOn(bundle.triggerEventStore, "sweepExpired")
    .mockResolvedValueOnce(100)
    .mockResolvedValueOnce(2);
  const now = new Date("2026-07-18T08:30:00.000Z");
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now) },
  });
  try {
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenNthCalledWith(1, {
      limit: 100,
      now: now.toISOString(),
    });
    expect(sweep).toHaveBeenNthCalledWith(2, {
      limit: 100,
      now: now.toISOString(),
    });
  } finally {
    await runtime.close();
  }
});

it("physically reclaims expired durable files while the runtime stays healthy", async () => {
  const bundle = await createPgliteStoreBundle();
  const projectId = "project_online_file_sweep";
  const fileId = createFileId("online_file_sweep");
  let now = Date.parse("2026-07-18T08:30:00.000Z");
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now) },
    fileSweepIntervalMs: 5,
  });
  try {
    await bundle.fileStore.put(projectId, {
      createdAt: new Date(now).toISOString(),
      meta: {
        fileId,
        name: "online-sweep.bin",
        mimeType: "application/octet-stream",
        size: 3,
        expiresAt: new Date(now + 1_000).toISOString(),
      },
      content: Uint8Array.from([1, 2, 3]),
    });
    const before = await bundle.client.query<{ present: boolean }>(
      "select exists(select 1 from staged_files where project_id = $1 and file_id = $2) as present",
      [projectId, fileId],
    );
    expect(before.rows[0]?.present).toBe(true);

    now += 1_000;
    await vi.waitFor(
      async () => {
        const after = await bundle.client.query<{ present: boolean }>(
          "select exists(select 1 from staged_files where project_id = $1 and file_id = $2) as present",
          [projectId, fileId],
        );
        expect(after.rows[0]?.present).toBe(false);
      },
      { interval: 10, timeout: 1_000 },
    );
  } finally {
    await runtime.close();
  }
});

it("drains more than one bounded trigger-event batch while the runtime stays healthy", async () => {
  const bundle = await createPgliteStoreBundle();
  const projectId = "project_online_trigger_event_sweep";
  let now = Date.parse("2026-07-18T08:30:00.000Z");
  let clockReads = 0;
  const runtime = await createExecutorRuntime({
    env: { EYEBALL_DATABASE_URL: "postgresql://contract.invalid/eyeball" },
    credentialProvider: new MockCredentialProvider([]),
    persistenceFactory: async () => bundle,
    clock: { now: () => new Date(now + clockReads++) },
    triggerEventSweepIntervalMs: 5,
  });
  try {
    const receivedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 60_000).toISOString();
    for (let index = 0; index < 101; index += 1) {
      await bundle.triggerEventStore.append(projectId, {
        arrivalId: createTriggerEventArrivalId(`online_sweep_${index}`),
        eventId: `evt_trigger_online_sweep_${index}`,
        subscriptionId: createTriggerSubscriptionId("online_sweep"),
        trigger: "slack.message_received",
        deliveryMode: "push",
        receivedAt,
        occurredAt: new Date(now - 1_000).toISOString(),
        dedupStatus: "accepted",
        deliveryAdmissionStatus: "admitted",
        requestedWebhookEndpointIds: ["whe_online_sweep"],
        expiresAt,
      });
    }
    const before = await bundle.client.query<{ count: number }>(
      "select count(*)::int as count from trigger_events where project_id = $1",
      [projectId],
    );
    expect(before.rows[0]?.count).toBe(101);

    const sweepNow: string[] = [];
    const sweepExpired = bundle.triggerEventStore.sweepExpired.bind(
      bundle.triggerEventStore,
    );
    vi.spyOn(bundle.triggerEventStore, "sweepExpired").mockImplementation(
      async (input) => {
        const deleted = await sweepExpired(input);
        if (deleted > 0) sweepNow.push(input.now);
        return deleted;
      },
    );
    now += 60_000;
    await vi.waitFor(
      async () => {
        const after = await bundle.client.query<{ count: number }>(
          "select count(*)::int as count from trigger_events where project_id = $1",
          [projectId],
        );
        expect(after.rows[0]?.count).toBe(0);
      },
      { interval: 10, timeout: 1_000 },
    );
    expect(sweepNow).toHaveLength(2);
    expect(new Set(sweepNow).size).toBe(1);
  } finally {
    await runtime.close();
  }
});

it("migrates staged file content as bytea with metadata and expiry columns", async () => {
  const bundle = await pgliteStores();
  const result = await bundle.client.query<{
    column_name: string;
    data_type: string;
  }>(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public'
        and table_name = 'staged_files'
      order by ordinal_position`,
  );
  expect(result.rows).toEqual([
    { column_name: "sequence", data_type: "bigint" },
    { column_name: "project_id", data_type: "text" },
    { column_name: "file_id", data_type: "text" },
    { column_name: "name", data_type: "text" },
    { column_name: "mime_type", data_type: "text" },
    { column_name: "size", data_type: "bigint" },
    { column_name: "content", data_type: "bytea" },
    { column_name: "created_at", data_type: "timestamp with time zone" },
    { column_name: "expires_at", data_type: "timestamp with time zone" },
  ]);
});

it("does not retain staged bytes when a Postgres insert fails", async () => {
  const bundle = await createPgliteStoreBundle();
  const sentinel = "file-write-plaintext-sentinel";
  const content = Uint8Array.from(Buffer.from(sentinel, "utf8"));
  try {
    await bundle.client.exec("drop table staged_files");
    let captured: unknown;
    try {
      await bundle.fileStore.put("project_failed_file_write", {
        createdAt: "2026-07-18T09:00:00.000Z",
        meta: {
          fileId: createFileId("failed_file_write"),
          name: "failed-write.bin",
          mimeType: "application/octet-stream",
          size: content.byteLength,
          expiresAt: "2026-07-18T10:00:00.000Z",
        },
        content,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const safeError = captured as Error;
    expect(safeError.message).toBe("Staged-file persistence failed.");
    expect(safeError.cause).toBeUndefined();
    const chain = errorChainText(safeError);
    expect(chain).not.toContain(sentinel);
    expect(chain).not.toContain([...content].join(","));
    expect(chain).not.toContain([...content].join(", "));
    expect(chain).not.toContain(
      [...content].map((byte) => byte.toString(16).padStart(2, "0")).join(" "),
    );
  } finally {
    await bundle.close();
  }
});

it("keeps uploaded staged bytes available across a PGlite restart until exact expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-file-restart-"));
  const apiKey = "ey_file_restart";
  const projectId = "project_file_restart";
  let now = Date.parse("2026-07-18T09:00:00.000Z");
  const clock = { now: () => new Date(now) };
  let first: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    const firstEngine = new (await import("../src/engine.js")).ExecutionEngine({
      fileStore: first.fileStore,
      clock,
      fileTtlMs: 1_000,
      fileIdFactory: () => createFileId("restart_round_trip"),
    });
    const firstApp = createExecutorApp({
      engine: firstEngine,
      apiKeys: { [apiKey]: projectId },
    });
    const uploaded = await firstApp.request("/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "restart.bin",
        mimeType: "application/octet-stream",
        content: Buffer.from([0, 1, 2, 254, 255]).toString("base64"),
      }),
    });
    expect(uploaded.status).toBe(201);
    await first.close();
    first = undefined;

    const restored = await createPgliteStoreBundle({ dataDir: directory });
    try {
      const { ExecutionEngine } = await import("../src/engine.js");
      const restoredEngine = new ExecutionEngine({
        fileStore: restored.fileStore,
        clock,
        fileTtlMs: 1_000,
      });
      const restoredApp = createExecutorApp({
        engine: restoredEngine,
        apiKeys: { [apiKey]: projectId },
      });
      const resolved = await restoredEngine.getFile(
        projectId,
        "file_restart_round_trip",
      );
      expect(resolved.meta).toMatchObject({
        fileId: "file_restart_round_trip",
        name: "restart.bin",
        size: 5,
      });
      expect(resolved.content).toEqual(Uint8Array.from([0, 1, 2, 254, 255]));
      const metadata = await restoredApp.request(
        "/v1/files/file_restart_round_trip",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(metadata.status).toBe(200);

      now += 1_000;
      const expired = await restoredApp.request(
        "/v1/files/file_restart_round_trip",
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      expect(expired.status).toBe(404);
      await expect(expired.json()).resolves.toMatchObject({
        error: { code: "not_found" },
      });
    } finally {
      await restored.close();
    }
  } finally {
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps durable webhook work reference-only", async () => {
  const bundle = await pgliteStores();
  const result = await bundle.client.query<{
    column_name: string;
    table_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('webhook_events', 'webhook_delivery_work')
      order by table_name, ordinal_position`,
  );
  const eventColumns = result.rows
    .filter(({ table_name }) => table_name === "webhook_events")
    .map(({ column_name }) => column_name);
  expect(eventColumns).toEqual([
    "sequence",
    "project_id",
    "event_id",
    "event_type",
    "source_kind",
    "source_id",
    "endpoint_ids",
    "created_at",
    "materialized_at",
  ]);
  expect(
    result.rows.some(
      ({ table_name }) => table_name === "webhook_delivery_work",
    ),
  ).toBe(false);
});

it("rebuilds execution, selection, and scheduled delivery jobs after a PGlite restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-job-recovery-"));
  const projectId = "project_restart_recovery";
  const executionId = createExecutionId("restart_recovery");
  const createdAt = "2026-07-18T05:00:00.000Z";
  const retryAt = "2026-07-18T05:10:00.000Z";
  const pending: ExecutionRecord & { status: "pending" } = {
    executionId,
    tool: "fixture.run",
    toolVersion: "1.0.0",
    catalogVersion: "2.0",
    status: "pending",
    userId: "user_restart_recovery",
    createdAt,
    source: {
      kind: "voice_session",
      sessionId: "session_restart_recovery",
    },
    attachments: {
      count: 1,
      fileIds: [createFileId("restart_recovery")],
    },
  };
  let first: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    await first.executionStore.allocate({
      projectId,
      record: pending,
      request: {
        tool: pending.tool,
        userId: pending.userId,
        input: { message: "persisted" },
        mode: "async",
      },
      recovery: {
        webhookEventId: "evt_restart_execution",
        resumeContext: {
          version: 1,
          tool: pending.tool,
          toolVersion: pending.toolVersion,
          toolkitSlug: "fixture",
          requiredScopes: [],
          concurrencyBucketKey: `${projectId}:fixture`,
        },
      },
    });
    await expect(
      first.executionStore.markReplayed(
        projectId,
        executionId,
        "2026-07-18T05:00:00.500Z",
      ),
    ).resolves.toBe(true);
    await first.webhookWorkStore.ensureEvent({
      projectId,
      eventId: "evt_restart_selection",
      eventType: "execution.succeeded",
      sourceKind: "execution",
      sourceId: executionId,
      endpointIds: [],
      createdAt,
      selectionRunAfter: createdAt,
    });
    await first.webhookWorkStore.ensureEvent({
      projectId,
      eventId: "evt_restart_delivery",
      eventType: "execution.failed",
      sourceKind: "execution",
      sourceId: executionId,
      endpointIds: ["whe_restart"],
      createdAt,
      selectionRunAfter: createdAt,
    });
    const [materialized] = await first.webhookWorkStore.materializeEvent({
      projectId,
      eventId: "evt_restart_delivery",
      endpointIds: ["whe_restart"],
      materializedAt: "2026-07-18T05:00:01.000Z",
    });
    if (materialized === undefined) {
      throw new Error("Expected a materialized webhook delivery.");
    }
    const delivering = {
      ...materialized.delivery,
      status: "delivering" as const,
    };
    await first.webhookDeliveryStore.update(projectId, delivering);
    await first.webhookDeliveryStore.update(projectId, {
      ...delivering,
      status: "pending",
      attempts: [
        {
          attempt: 1,
          attemptedAt: "2026-07-18T05:00:02.000Z",
          completedAt: "2026-07-18T05:00:03.000Z",
          statusCode: 503,
        },
      ],
      nextRetryAt: retryAt,
    });
    await first.close();
    first = undefined;

    const restored = await createPgliteStoreBundle({ dataDir: directory });
    try {
      await expect(
        restored.executionStore.get(projectId, executionId),
      ).resolves.toMatchObject({
        replayed: true,
        source: pending.source,
        attachments: pending.attachments,
      });
      const persisted = await restored.client.query<{
        record: Record<string, unknown>;
        replay_observed_at: string | Date | null;
      }>(
        `select record, replay_observed_at
           from executions
          where project_id = $1 and execution_id = $2`,
        [projectId, executionId],
      );
      expect(persisted.rows[0]?.record).not.toHaveProperty("replayed");
      expect(persisted.rows[0]?.replay_observed_at).not.toBeNull();
      const clock = { now: () => new Date("2026-07-18T05:01:00.000Z") };
      const recovery = {
        jobStore: restored.jobStore,
        executionStore: restored.executionStore,
        webhookWorkStore: restored.webhookWorkStore,
        webhookDeliveryStore: restored.webhookDeliveryStore,
        clock,
        logger: noopLogger,
      };
      await recoverExecutorJobs(recovery);
      await recoverExecutorJobs(recovery);

      const executionJob = {
        kind: "execution.run.v1" as const,
        payload: { projectId, executionId },
      };
      const selectionJob = {
        kind: "webhook.select.v1" as const,
        payload: { projectId, eventId: "evt_restart_selection" },
      };
      const deliveryJob = {
        kind: "webhook.deliver.v1" as const,
        payload: {
          projectId,
          deliveryId: materialized.delivery.deliveryId,
        },
      };
      await expect(
        restored.jobStore.get(executorJobId(executionJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: executionJob,
      });
      await expect(
        restored.jobStore.get(executorJobId(selectionJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: selectionJob,
      });
      await expect(
        restored.jobStore.get(executorJobId(deliveryJob)),
      ).resolves.toMatchObject({
        state: "pending",
        description: deliveryJob,
        runAfter: retryAt,
        groupKey: webhookEndpointGroupKey(projectId, "whe_restart"),
        groupOrder: materialized.sequence,
      });
    } finally {
      await restored.close();
    }
  } finally {
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("leaves a webhook delivery owned by a healthy replica untouched during recovery", async () => {
  const projectId = "project_active_delivery_recovery";
  const createdAt = "2026-07-18T06:00:00.000Z";
  const now = "2026-07-18T06:00:01.000Z";
  const deliveryStore = new InMemoryWebhookDeliveryStore();
  const jobStore = new InMemoryJobStore();
  const workStore = new InMemoryWebhookWorkStore(deliveryStore, jobStore);
  await workStore.ensureEvent({
    projectId,
    eventId: "evt_active_delivery",
    eventType: "execution.succeeded",
    sourceKind: "execution",
    sourceId: "exe_active_delivery",
    endpointIds: ["whe_active"],
    createdAt,
    selectionRunAfter: createdAt,
  });
  const [materialized] = await workStore.materializeEvent({
    projectId,
    eventId: "evt_active_delivery",
    endpointIds: ["whe_active"],
    materializedAt: now,
  });
  if (materialized === undefined) {
    throw new Error("Expected a materialized webhook delivery.");
  }
  await deliveryStore.update(projectId, {
    ...materialized.delivery,
    status: "delivering",
  });
  const job = {
    kind: "webhook.deliver.v1" as const,
    payload: {
      projectId,
      deliveryId: materialized.delivery.deliveryId,
    },
  };
  const envelope = createJobEnvelope(
    job,
    {
      runAfter: createdAt,
      groupKey: webhookEndpointGroupKey(projectId, "whe_active"),
      groupOrder: materialized.sequence,
    },
    new Date(createdAt),
  );
  await jobStore.ensure(envelope);
  await jobStore.claim({
    queueName: "webhook-delivery",
    workerId: "healthy-worker",
    now,
    leaseExpiresAt: "2026-07-18T06:01:01.000Z",
    limit: 1,
  });

  await recoverExecutorJobs({
    jobStore,
    executionStore: new InMemoryExecutionStore(),
    webhookWorkStore: workStore,
    webhookDeliveryStore: deliveryStore,
    clock: { now: () => new Date(now) },
    logger: noopLogger,
  });

  await expect(
    deliveryStore.get(projectId, materialized.delivery.deliveryId),
  ).resolves.toMatchObject({ status: "delivering" });
  await expect(jobStore.get(envelope.jobId)).resolves.toMatchObject({
    state: "running",
    claimedBy: "healthy-worker",
  });
});

it("persists observer checkpoints, lease fencing, backfill, and voice sources across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eyeball-observer-restart-"));
  const projectId = "project_observer_restart";
  const userId = "user_observer_restart";
  const sessionId = "session_observer_restart";
  const now = "2026-07-21T11:00:00.000Z";
  const event = {
    id: "voice_event_observer_restart_1",
    type: "voice.session.event" as const,
    createdAt: now,
    projectId,
    data: {
      id: "voice_event_observer_restart_1",
      sessionId,
      sequence: 1,
      createdAt: now,
      data: { type: "session.lifecycle" as const, to: "created" as const },
    },
  };
  let first: PgliteStoreBundle | undefined;
  try {
    first = await createPgliteStoreBundle({ dataDir: directory });
    const agent = await first.agentStore.createAgent(
      projectId,
      contractAgentDraft,
      now,
    );
    const pointer = {
      sessionId,
      projectId,
      userId,
      agentId: agent.id,
      agentRevision: agent.revision,
      callId: `call_${sessionId}`,
      createdAt: now,
    };
    await first.agentStore.rememberSession(pointer);
    await first.voiceObserverStore.ensurePrepared(
      pointer,
      now,
      "2026-07-21T11:01:00.000Z",
    );
    await expect(
      first.voiceObserverStore.claim({
        leaseOwner: "observer-before-start-resolves",
        now,
        leaseExpiresAt: "2026-07-21T11:01:00.000Z",
        limit: 1,
      }),
    ).resolves.toEqual([]);
    await first.voiceObserverStore.activatePrepared(sessionId, now);
    const [claim] = await first.voiceObserverStore.claim({
      leaseOwner: "observer-a",
      now,
      leaseExpiresAt: "2026-07-21T11:01:00.000Z",
      limit: 1,
    });
    if (claim === undefined) throw new Error("Expected an observer claim.");
    await expect(
      first.voiceObserverStore.advanceSequence({
        sessionId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        now,
        expectedSequence: 0,
        handledSequence: 1,
      }),
    ).resolves.toBe(true);
    await expect(
      first.voiceObserverStore.advanceSequence({
        sessionId,
        leaseOwner: claim.leaseOwner,
        leaseToken: claim.leaseToken,
        now,
        expectedSequence: 0,
        handledSequence: 1,
      }),
    ).resolves.toBe(false);
    await first.voiceObserverStore.recordFailure({
      sessionId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      now,
      kind: "timeout",
      operation: "get_events",
      failedAt: now,
      nextAttemptAt: "2026-07-21T11:02:00.000Z",
    });
    await first.voiceObserverStore.release({
      sessionId,
      leaseOwner: claim.leaseOwner,
      leaseToken: claim.leaseToken,
      now,
    });
    await first.voiceWebhookSourceStore.ensureSource({
      projectId,
      eventId: event.id,
      sessionId,
      eventType: event.type,
      sourceKind: "session_event",
      workerSequence: 1,
      envelope: event,
      createdAt: now,
    });

    const backfillSessionId = "session_observer_backfill";
    await first.agentStore.rememberSession({
      ...pointer,
      sessionId: backfillSessionId,
      callId: `call_${backfillSessionId}`,
    });
    await expect(
      first.voiceObserverStore.backfillMissing({ now, limit: 10 }),
    ).resolves.toBe(1);
    await expect(
      first.voiceObserverStore.backfillMissing({ now, limit: 10 }),
    ).resolves.toBe(0);
    await first.close();
    first = undefined;

    const restored = await createPgliteStoreBundle({ dataDir: directory });
    try {
      await expect(
        restored.voiceObserverStore.get(sessionId),
      ).resolves.toMatchObject({
        status: "observing",
        handledSequence: 1,
        consecutiveFailures: 1,
        lastFailureKind: "timeout",
        nextAttemptAt: "2026-07-21T11:02:00.000Z",
      });
      await expect(
        restored.voiceObserverStore.claim({
          leaseOwner: "observer-too-early",
          now: "2026-07-21T11:01:59.000Z",
          leaseExpiresAt: "2026-07-21T11:02:59.000Z",
          limit: 1,
        }),
      ).resolves.toEqual([
        expect.objectContaining({ sessionId: "session_observer_backfill" }),
      ]);
      const [restoredClaim] = await restored.voiceObserverStore.claim({
        leaseOwner: "observer-b",
        now: "2026-07-21T11:02:00.000Z",
        leaseExpiresAt: "2026-07-21T11:03:00.000Z",
        limit: 10,
      });
      if (restoredClaim === undefined) {
        throw new Error("Expected restored observer claim.");
      }
      await expect(
        restored.voiceObserverStore.claim({
          leaseOwner: "observer-c",
          now: "2026-07-21T11:02:30.000Z",
          leaseExpiresAt: "2026-07-21T11:03:30.000Z",
          limit: 10,
        }),
      ).resolves.toEqual([]);
      await expect(
        restored.voiceObserverStore.advanceSequence({
          sessionId,
          leaseOwner: "observer-a",
          leaseToken: "stale-token",
          now: "2026-07-21T11:02:30.000Z",
          expectedSequence: 1,
          handledSequence: 2,
        }),
      ).resolves.toBe(false);
      await expect(
        restored.voiceWebhookSourceStore.getSource(projectId, event.id),
      ).resolves.toMatchObject({
        sourceKind: "session_event",
        workerSequence: 1,
        envelope: event,
      });
      await expect(
        restored.voiceWebhookSourceStore.ensureSource({
          projectId,
          eventId: event.id,
          sessionId,
          eventType: event.type,
          sourceKind: "session_event",
          workerSequence: 1,
          envelope: event,
          createdAt: now,
        }),
      ).resolves.toBe("existing");
      await expect(
        restored.voiceWebhookSourceStore.ensureSource({
          projectId,
          eventId: event.id,
          sessionId,
          eventType: event.type,
          sourceKind: "session_event",
          workerSequence: 1,
          envelope: { ...event, createdAt: "2026-07-21T11:00:01.000Z" },
          createdAt: now,
        }),
      ).rejects.toThrow("reused with different content");
    } finally {
      await restored.close();
    }
  } finally {
    await first?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
