import type {
  ExecuteRequest,
  ExecutionRecord,
  JsonValue,
  TriggerSubscriptionStatus,
  WebhookDeliveryStatus,
  WebhookEventType,
  WebhookSubscriptionEventType,
} from "@eyeball/core";
import {
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const timestampColumn = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });

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
  executions,
  executionIdempotency,
  webhookEndpoints,
  webhookDeliveries,
  webhookDeliveryAttempts,
  triggerSubscriptions,
  triggerStates,
  triggerDedupClaims,
};

export type PostgresSchema = typeof postgresSchema;
