import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { StoredMcpTask } from "../../session-store.js";

const timestampColumn = (name: string) =>
  timestamp(name, { mode: "string", withTimezone: true });

export const mcpSessions = pgTable(
  "mcp_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    protocolVersion: text("protocol_version").notNull(),
    authBinding: text("auth_binding").notNull(),
    tasksEnabled: boolean("tasks_enabled").notNull(),
    createdAt: timestampColumn("created_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    catalogVersion: text("catalog_version"),
    tasks: jsonb("tasks")
      .$type<Readonly<Record<string, StoredMcpTask>>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    index("mcp_sessions_expiry_idx").on(table.expiresAt),
    check(
      "mcp_sessions_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "mcp_sessions_tasks_object_check",
      sql`jsonb_typeof(${table.tasks}) = 'object'`,
    ),
  ],
);

export const mcpGatewayPostgresSchema = { mcpSessions };

export type McpGatewayPostgresSchema = typeof mcpGatewayPostgresSchema;
