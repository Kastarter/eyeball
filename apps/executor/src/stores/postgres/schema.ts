import type {
  ExecuteRequest,
  ExecutionRecord,
  JsonValue,
  TriggerSubscriptionStatus,
  VoiceAgentDefinition,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookSubscriptionEventType,
} from "@eyeball/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { JobState } from "../../jobs/store.js";
import type { ExecutorJob } from "../../jobs/types.js";
import type { ExecutionResumeContext } from "../../store.js";
import type {
  UsageOutboxState,
  UsageReportPayload,
} from "../../usage/outbox.js";
import type {
  VoiceObserverFailureKind,
  VoiceObserverOperation,
  VoiceObserverStatus,
  VoiceObserverTranscriptStatus,
} from "../../voice/observer-store.js";
import type {
  VoiceWebhookEvent,
  VoiceWebhookSourceKind,
} from "../../webhooks/voice-source-store.js";
import type { WebhookEventSourceKind } from "../../webhooks/work-store.js";

const timestampColumn = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => Uint8Array.from(value),
});

export const voiceAgents = pgTable(
  "voice_agents",
  {
    projectId: text("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    activeRevision: integer("active_revision").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    deletedAt: timestampColumn("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.agentId] }),
    index("voice_agents_project_created_idx").on(
      table.projectId,
      table.createdAt,
      table.agentId,
    ),
    check(
      "voice_agents_active_revision_positive",
      sql`${table.activeRevision} >= 1`,
    ),
  ],
);

export const voiceAgentRevisions = pgTable(
  "voice_agent_revisions",
  {
    projectId: text("project_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    definition: jsonb("definition").$type<VoiceAgentDefinition>().notNull(),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.agentId, table.revision],
    }),
    foreignKey({
      columns: [table.projectId, table.agentId],
      foreignColumns: [voiceAgents.projectId, voiceAgents.agentId],
      name: "voice_agent_revisions_agent_fk",
    }),
    check(
      "voice_agent_revisions_revision_positive",
      sql`${table.revision} >= 1`,
    ),
    check(
      "voice_agent_revisions_definition_id_check",
      sql`${table.definition}->>'id' = ${table.agentId}`,
    ),
    check(
      "voice_agent_revisions_definition_revision_check",
      sql`(${table.definition}->>'revision')::integer = ${table.revision}`,
    ),
  ],
);

export const voiceAgentNumberBindings = pgTable(
  "voice_agent_number_bindings",
  {
    projectId: text("project_id").notNull(),
    phoneNumber: text("phone_number").notNull(),
    bindingId: text("binding_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    transportConnectionId: text("transport_connection_id").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.phoneNumber] }),
    uniqueIndex("voice_agent_number_bindings_binding_id_uidx").on(
      table.bindingId,
    ),
    index("voice_agent_number_bindings_project_phone_idx").on(
      table.projectId,
      table.phoneNumber,
      table.bindingId,
    ),
    foreignKey({
      columns: [table.projectId, table.agentId, table.revision],
      foreignColumns: [
        voiceAgentRevisions.projectId,
        voiceAgentRevisions.agentId,
        voiceAgentRevisions.revision,
      ],
      name: "voice_agent_number_bindings_revision_fk",
    }),
    check(
      "voice_agent_number_bindings_revision_positive",
      sql`${table.revision} >= 1`,
    ),
  ],
);

export const voiceAgentSessionPointers = pgTable(
  "voice_agent_session_pointers",
  {
    sessionId: text("session_id").primaryKey(),
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    callId: text("call_id").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    grantId: text("grant_id"),
    grantExpiresAt: timestampColumn("grant_expires_at"),
    grantRevokedAt: timestampColumn("grant_revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.agentId, table.agentRevision],
      foreignColumns: [
        voiceAgentRevisions.projectId,
        voiceAgentRevisions.agentId,
        voiceAgentRevisions.revision,
      ],
      name: "voice_agent_session_pointers_revision_fk",
    }),
    index("voice_agent_session_pointers_scope_created_idx").on(
      table.projectId,
      table.userId,
      table.createdAt.desc(),
      table.sessionId.desc(),
    ),
    check(
      "voice_agent_session_pointers_revision_positive",
      sql`${table.agentRevision} >= 1`,
    ),
    check(
      "voice_agent_session_pointers_grant_identity_complete",
      sql`(${table.grantId} IS NULL AND ${table.grantExpiresAt} IS NULL) OR (${table.grantId} IS NOT NULL AND ${table.grantExpiresAt} IS NOT NULL)`,
    ),
    check(
      "voice_agent_session_pointers_revocation_requires_grant",
      sql`${table.grantRevokedAt} IS NULL OR ${table.grantId} IS NOT NULL`,
    ),
    uniqueIndex("voice_agent_session_pointers_grant_id_unique")
      .on(table.grantId)
      .where(sql`${table.grantId} IS NOT NULL`),
  ],
);

export const voiceAgentSessionObservers = pgTable(
  "voice_agent_session_observers",
  {
    sessionId: text("session_id").primaryKey(),
    handledSequence: integer("handled_sequence").default(0).notNull(),
    status: text("status").$type<VoiceObserverStatus>().notNull(),
    terminalSequence: integer("terminal_sequence"),
    terminalHandledAt: timestampColumn("terminal_handled_at"),
    transcriptStatus: text("transcript_status")
      .$type<VoiceObserverTranscriptStatus>()
      .notNull(),
    transcriptHandledAt: timestampColumn("transcript_handled_at"),
    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lastFailureKind:
      text("last_failure_kind").$type<VoiceObserverFailureKind>(),
    lastFailureOperation: text(
      "last_failure_operation",
    ).$type<VoiceObserverOperation>(),
    lastFailureAt: timestampColumn("last_failure_at"),
    nextAttemptAt: timestampColumn("next_attempt_at"),
    exhaustedAt: timestampColumn("exhausted_at"),
    exhaustionSignaledAt: timestampColumn("exhaustion_signaled_at"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [voiceAgentSessionPointers.sessionId],
      name: "voice_agent_session_observers_pointer_fk",
    }).onDelete("cascade"),
    index("voice_agent_session_observers_recovery_idx").on(
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
      table.sessionId,
    ),
    check(
      "voice_agent_session_observers_handled_nonnegative",
      sql`${table.handledSequence} >= 0`,
    ),
    check(
      "voice_agent_session_observers_failures_nonnegative",
      sql`${table.consecutiveFailures} >= 0`,
    ),
    check(
      "voice_agent_session_observers_status_check",
      sql`${table.status} IN ('prepared', 'observing', 'finalizing', 'completed', 'exhausted', 'cancelled')`,
    ),
    check(
      "voice_agent_session_observers_transcript_check",
      sql`${table.transcriptStatus} IN ('pending', 'admitted', 'skipped')`,
    ),
    check(
      "voice_agent_session_observers_terminal_sequence_positive",
      sql`${table.terminalSequence} IS NULL OR ${table.terminalSequence} >= 1`,
    ),
    check(
      "voice_agent_session_observers_terminal_handling_check",
      sql`${table.terminalHandledAt} IS NULL OR ${table.terminalSequence} IS NOT NULL`,
    ),
    check(
      "voice_agent_session_observers_transcript_handling_check",
      sql`(${table.transcriptStatus} = 'pending' AND ${table.transcriptHandledAt} IS NULL) OR (${table.transcriptStatus} IN ('admitted', 'skipped') AND ${table.transcriptHandledAt} IS NOT NULL)`,
    ),
    check(
      "voice_agent_session_observers_failure_metadata_check",
      sql`(${table.consecutiveFailures} = 0 AND ${table.lastFailureKind} IS NULL AND ${table.lastFailureOperation} IS NULL AND ${table.lastFailureAt} IS NULL) OR (${table.consecutiveFailures} > 0 AND ${table.lastFailureKind} IS NOT NULL AND ${table.lastFailureOperation} IS NOT NULL AND ${table.lastFailureAt} IS NOT NULL)`,
    ),
    check(
      "voice_agent_session_observers_failure_kind_check",
      sql`${table.lastFailureKind} IS NULL OR ${table.lastFailureKind} IN ('provider_unavailable', 'timeout', 'invalid_response', 'publication_error', 'internal_error')`,
    ),
    check(
      "voice_agent_session_observers_failure_operation_check",
      sql`${table.lastFailureOperation} IS NULL OR ${table.lastFailureOperation} IN ('get_events', 'get_session', 'publish_event', 'publish_transcript', 'publish_failure')`,
    ),
    check(
      "voice_agent_session_observers_lease_complete",
      sql`(${table.leaseOwner} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      "voice_agent_session_observers_exhaustion_check",
      sql`(${table.status} = 'exhausted' AND ${table.exhaustedAt} IS NOT NULL) OR (${table.status} <> 'exhausted' AND ${table.exhaustedAt} IS NULL)`,
    ),
    check(
      "voice_agent_session_observers_signal_check",
      sql`${table.exhaustionSignaledAt} IS NULL OR ${table.exhaustedAt} IS NOT NULL`,
    ),
    check(
      "voice_agent_session_observers_finalization_check",
      sql`${table.status} NOT IN ('finalizing', 'completed') OR (${table.terminalSequence} IS NOT NULL AND ${table.terminalHandledAt} IS NOT NULL)`,
    ),
    check(
      "voice_agent_session_observers_completion_check",
      sql`${table.status} <> 'completed' OR ${table.transcriptStatus} IN ('admitted', 'skipped')`,
    ),
    check(
      "voice_agent_session_observers_terminal_lease_check",
      sql`(${table.status} NOT IN ('completed', 'cancelled') OR ${table.leaseOwner} IS NULL) AND (${table.status} <> 'exhausted' OR ${table.exhaustionSignaledAt} IS NULL OR ${table.leaseOwner} IS NULL)`,
    ),
    check(
      "voice_agent_session_observers_terminal_schedule_check",
      sql`${table.status} NOT IN ('completed', 'exhausted', 'cancelled') OR ${table.nextAttemptAt} IS NULL`,
    ),
  ],
);

export const voiceAgentMessageReceipts = pgTable(
  "voice_agent_message_receipts",
  {
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    message: text("message").notNull(),
    userMessageId: text("user_message_id").notNull(),
    assistantMessage: text("assistant_message").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.userId,
        table.sessionId,
        table.clientMessageId,
      ],
    }),
  ],
);

export const stagedFiles = pgTable(
  "staged_files",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    projectId: text("project_id").notNull(),
    fileId: text("file_id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    content: bytea("content").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.fileId] }),
    index("staged_files_project_created_idx").on(
      table.projectId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("staged_files_expiry_idx").on(table.expiresAt, table.sequence),
    check("staged_files_size_nonnegative", sql`${table.size} >= 0`),
    check(
      "staged_files_content_size_check",
      sql`octet_length(${table.content}) = ${table.size}`,
    ),
    check(
      "staged_files_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "staged_files_name_length_check",
      sql`octet_length(${table.name}) BETWEEN 1 AND 255`,
    ),
    check(
      "staged_files_mime_type_length_check",
      sql`char_length(${table.mimeType}) BETWEEN 1 AND 255`,
    ),
  ],
);

export const executions = pgTable(
  "executions",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    projectId: text("project_id").notNull(),
    executionId: text("execution_id").notNull(),
    status: text("status").$type<ExecutionRecord["status"]>().notNull(),
    tool: text("tool").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    record: jsonb("record").$type<ExecutionRecord>().notNull(),
    request: jsonb("request").$type<ExecuteRequest>().notNull(),
    idempotencyKey: text("idempotency_key"),
    resolvedConnectionId: text("resolved_connection_id"),
    resumeContext: jsonb("resume_context").$type<ExecutionResumeContext>(),
    dispatchStartedAt: timestampColumn("dispatch_started_at"),
    webhookEventId: text("webhook_event_id"),
    webhookPublishedAt: timestampColumn("webhook_published_at"),
    usageFinalizedAt: timestampColumn("usage_finalized_at"),
    replayObservedAt: timestampColumn("replay_observed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.executionId] }),
    index("executions_project_time_idx").on(
      table.projectId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("executions_project_status_time_idx").on(
      table.projectId,
      table.status,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("executions_project_tool_time_idx").on(
      table.projectId,
      table.tool,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("executions_project_user_time_idx").on(
      table.projectId,
      table.userId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("executions_recovery_status_idx").on(table.status, table.sequence),
    index("executions_webhook_publication_idx").on(
      table.webhookPublishedAt,
      table.sequence,
    ),
    index("executions_usage_finalization_idx").on(
      table.usageFinalizedAt,
      table.sequence,
    ),
  ],
);

export const taskJobs = pgTable(
  "task_jobs",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    jobId: text("job_id").primaryKey(),
    queueName: text("queue_name").notNull(),
    kind: text("kind").$type<ExecutorJob["kind"]>().notNull(),
    payload: jsonb("payload").$type<ExecutorJob["payload"]>().notNull(),
    state: text("state").$type<JobState>().notNull(),
    groupKey: text("group_key"),
    groupOrder: bigint("group_order", { mode: "number" }),
    runAfter: timestampColumn("run_after").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    claimedBy: text("claimed_by"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    index("task_jobs_queue_state_run_after_idx").on(
      table.queueName,
      table.state,
      table.runAfter,
      table.sequence,
    ),
    index("task_jobs_queue_lease_expiry_idx").on(
      table.queueName,
      table.state,
      table.leaseExpiresAt,
    ),
    index("task_jobs_group_order_idx").on(
      table.queueName,
      table.groupKey,
      table.groupOrder,
      table.sequence,
    ),
    check("task_jobs_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "task_jobs_kind_queue_check",
      sql`(${table.kind} = 'execution.run.v1' AND ${table.queueName} = 'execution') OR (${table.kind} = 'webhook.select.v1' AND ${table.queueName} = 'webhook-selection') OR (${table.kind} = 'webhook.deliver.v1' AND ${table.queueName} = 'webhook-delivery')`,
    ),
    check(
      "task_jobs_group_pair_check",
      sql`(${table.groupKey} IS NULL AND ${table.groupOrder} IS NULL) OR (${table.groupKey} IS NOT NULL AND ${table.groupOrder} IS NOT NULL AND ${table.groupOrder} >= 0)`,
    ),
    check(
      "task_jobs_state_check",
      sql`${table.state} IN ('pending', 'running', 'succeeded', 'failed')`,
    ),
    check(
      "task_jobs_lease_state_check",
      sql`(${table.state} = 'running' AND ${table.claimedBy} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL) OR (${table.state} <> 'running' AND ${table.claimedBy} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "task_jobs_completion_state_check",
      sql`(${table.state} IN ('succeeded', 'failed') AND ${table.completedAt} IS NOT NULL) OR (${table.state} IN ('pending', 'running') AND ${table.completedAt} IS NULL)`,
    ),
  ],
);

export const executionIdempotency = pgTable(
  "execution_idempotency",
  {
    projectId: text("project_id").notNull(),
    key: text("idempotency_key").notNull(),
    tool: text("tool").notNull(),
    userId: text("user_id").notNull(),
    connectionId: text("connection_id").notNull(),
    catalogMajor: text("catalog_major").notNull(),
    requestHash: text("request_hash").notNull(),
    executionId: text("execution_id").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    resolvedConnectionId: text("resolved_connection_id"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.projectId,
        table.key,
        table.tool,
        table.userId,
        table.connectionId,
        table.catalogMajor,
      ],
    }),
    foreignKey({
      columns: [table.projectId, table.executionId],
      foreignColumns: [executions.projectId, executions.executionId],
      name: "execution_idempotency_execution_fk",
    }).onDelete("cascade"),
    index("execution_idempotency_expiry_idx").on(table.expiresAt),
  ],
);

export const usageOutbox = pgTable(
  "usage_outbox",
  {
    executionId: text("execution_id").primaryKey(),
    payload: jsonb("payload").$type<UsageReportPayload>().notNull(),
    state: text("state").$type<UsageOutboxState>().notNull(),
    attempts: integer("attempts").notNull(),
    nextRetryAt: timestampColumn("next_retry_at").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
    sentAt: timestampColumn("sent_at"),
  },
  (table) => [
    index("usage_outbox_state_retry_idx").on(
      table.state,
      table.nextRetryAt,
      table.createdAt,
    ),
  ],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    projectId: text("project_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    secretPrefix: text("secret_prefix").notNull(),
    events: jsonb("events")
      .$type<readonly WebhookSubscriptionEventType[]>()
      .notNull(),
    active: boolean("active").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.endpointId] }),
    index("webhook_endpoints_project_time_idx").on(
      table.projectId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("webhook_endpoints_project_active_idx").on(
      table.projectId,
      table.active,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    projectId: text("project_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    status: text("status").$type<WebhookDeliveryStatus>().notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    nextRetryAt: timestampColumn("next_retry_at"),
    completedAt: timestampColumn("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.deliveryId] }),
    index("webhook_deliveries_endpoint_time_idx").on(
      table.projectId,
      table.endpointId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("webhook_deliveries_status_retry_idx").on(
      table.status,
      table.nextRetryAt,
    ),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    projectId: text("project_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    attempt: integer("attempt").notNull(),
    attemptedAt: timestampColumn("attempted_at").notNull(),
    completedAt: timestampColumn("completed_at").notNull(),
    statusCode: integer("status_code"),
    error: text("error"),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.deliveryId, table.attempt],
    }),
    foreignKey({
      columns: [table.projectId, table.deliveryId],
      foreignColumns: [
        webhookDeliveries.projectId,
        webhookDeliveries.deliveryId,
      ],
      name: "webhook_delivery_attempts_delivery_fk",
    }).onDelete("cascade"),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    projectId: text("project_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").$type<WebhookEventType>().notNull(),
    sourceKind: text("source_kind").$type<WebhookEventSourceKind>().notNull(),
    sourceId: text("source_id").notNull(),
    endpointIds: jsonb("endpoint_ids").$type<readonly string[] | null>(),
    createdAt: timestampColumn("created_at").notNull(),
    materializedAt: timestampColumn("materialized_at"),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.eventId] }),
    index("webhook_events_materialization_idx").on(
      table.materializedAt,
      table.createdAt,
      table.sequence,
    ),
    check(
      "webhook_events_source_kind_check",
      sql`${table.sourceKind} IN ('execution', 'trigger', 'voice-session-event', 'voice-transcript', 'voice-observer-failure')`,
    ),
  ],
);

export const voiceWebhookSources = pgTable(
  "voice_webhook_sources",
  {
    projectId: text("project_id").notNull(),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id").notNull(),
    eventType: text("event_type").$type<VoiceWebhookEvent["type"]>().notNull(),
    sourceKind: text("source_kind").$type<VoiceWebhookSourceKind>().notNull(),
    workerSequence: integer("worker_sequence"),
    envelope: jsonb("envelope").$type<VoiceWebhookEvent>().notNull(),
    createdAt: timestampColumn("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.eventId] }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [voiceAgentSessionPointers.sessionId],
      name: "voice_webhook_sources_session_fk",
    }).onDelete("cascade"),
    uniqueIndex("voice_webhook_sources_worker_sequence_uidx")
      .on(table.sessionId, table.workerSequence)
      .where(sql`${table.workerSequence} IS NOT NULL`),
    index("voice_webhook_sources_session_created_idx").on(
      table.sessionId,
      table.createdAt,
      table.eventId,
    ),
    check(
      "voice_webhook_sources_sequence_check",
      sql`(${table.sourceKind} = 'session_event' AND ${table.workerSequence} IS NOT NULL AND ${table.workerSequence} >= 1) OR (${table.sourceKind} IN ('transcript', 'observer_failure') AND ${table.workerSequence} IS NULL)`,
    ),
    check(
      "voice_webhook_sources_type_check",
      sql`(${table.sourceKind} = 'session_event' AND ${table.eventType} = 'voice.session.event') OR (${table.sourceKind} = 'transcript' AND ${table.eventType} = 'voice.transcript.ready') OR (${table.sourceKind} = 'observer_failure' AND ${table.eventType} = 'voice.observer.failed')`,
    ),
    check(
      "voice_webhook_sources_envelope_identity_check",
      sql`${table.envelope}->>'id' = ${table.eventId} AND ${table.envelope}->>'type' = ${table.eventType} AND ${table.envelope}->>'projectId' = ${table.projectId} AND ${table.envelope}->'data'->>'sessionId' = ${table.sessionId}`,
    ),
  ],
);

export const triggerSubscriptions = pgTable(
  "trigger_subscriptions",
  {
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    subscriptionId: text("subscription_id").primaryKey(),
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    trigger: text("trigger").notNull(),
    connectionId: text("connection_id"),
    webhookEndpointIds: jsonb("webhook_endpoint_ids")
      .$type<readonly string[]>()
      .notNull(),
    filters: jsonb("filters").$type<Readonly<Record<string, JsonValue>>>(),
    pollIntervalSeconds: integer("poll_interval_seconds"),
    status: text("status").$type<TriggerSubscriptionStatus>().notNull(),
    ingestSecretHash: text("ingest_secret_hash"),
    createdAt: timestampColumn("created_at").notNull(),
    updatedAt: timestampColumn("updated_at").notNull(),
  },
  (table) => [
    index("trigger_subscriptions_project_time_idx").on(
      table.projectId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("trigger_subscriptions_project_user_time_idx").on(
      table.projectId,
      table.userId,
      table.createdAt.desc(),
      table.sequence.desc(),
    ),
    index("trigger_subscriptions_active_idx").on(table.status),
  ],
);

export const triggerStates = pgTable("trigger_states", {
  subscriptionId: text("subscription_id").primaryKey(),
  cursor: text("cursor"),
  nextPollAt: timestampColumn("next_poll_at"),
  updatedAt: timestampColumn("updated_at").notNull(),
});

export const triggerDedupClaims = pgTable(
  "trigger_dedup_claims",
  {
    subscriptionId: text("subscription_id").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subscriptionId, table.providerEventId] }),
    index("trigger_dedup_claims_expiry_idx").on(table.expiresAt),
  ],
);

export const postgresSchema = {
  voiceAgents,
  voiceAgentRevisions,
  voiceAgentNumberBindings,
  voiceAgentSessionPointers,
  voiceAgentSessionObservers,
  voiceAgentMessageReceipts,
  stagedFiles,
  executions,
  executionIdempotency,
  taskJobs,
  usageOutbox,
  webhookEndpoints,
  webhookDeliveries,
  webhookDeliveryAttempts,
  webhookEvents,
  voiceWebhookSources,
  triggerSubscriptions,
  triggerStates,
  triggerDedupClaims,
};

export type PostgresSchema = typeof postgresSchema;
