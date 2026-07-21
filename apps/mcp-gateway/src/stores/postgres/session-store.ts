import { eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { SessionStore, StoredMcpSession } from "../../session-store.js";
import type { McpGatewayPostgresDatabase } from "./database.js";
import { mcpSessions } from "./schema.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function sessionFromRow(
  row: typeof mcpSessions.$inferSelect,
): StoredMcpSession {
  return {
    sessionId: row.sessionId,
    protocolVersion: row.protocolVersion,
    authBinding: row.authBinding,
    tasksEnabled: row.tasksEnabled,
    createdAt: isoTimestamp(row.createdAt),
    expiresAt: isoTimestamp(row.expiresAt),
    ...(row.catalogVersion === null
      ? {}
      : { catalogVersion: row.catalogVersion }),
    tasks: copy(row.tasks),
  };
}

function sessionValues(session: StoredMcpSession) {
  return {
    sessionId: session.sessionId,
    protocolVersion: session.protocolVersion,
    authBinding: session.authBinding,
    tasksEnabled: session.tasksEnabled,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    catalogVersion: session.catalogVersion ?? null,
    tasks: copy(session.tasks),
  };
}

/** Atomic Postgres persistence for negotiated MCP sessions and task records. */
export class PostgresSessionStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements SessionStore
{
  readonly #database: McpGatewayPostgresDatabase<TQueryResult>;

  constructor(database: McpGatewayPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async get(sessionId: string): Promise<StoredMcpSession | undefined> {
    const [row] = await this.#database
      .select()
      .from(mcpSessions)
      .where(eq(mcpSessions.sessionId, sessionId))
      .limit(1);
    return row === undefined ? undefined : copy(sessionFromRow(row));
  }

  async set(session: StoredMcpSession): Promise<void> {
    const values = sessionValues(session);
    await this.#database
      .insert(mcpSessions)
      .values(values)
      .onConflictDoUpdate({
        target: mcpSessions.sessionId,
        set: {
          protocolVersion: values.protocolVersion,
          authBinding: values.authBinding,
          tasksEnabled: values.tasksEnabled,
          createdAt: values.createdAt,
          expiresAt: values.expiresAt,
          catalogVersion: values.catalogVersion,
          tasks: values.tasks,
        },
      });
  }

  async update(
    sessionId: string,
    updater: (session: StoredMcpSession) => StoredMcpSession | undefined,
  ): Promise<StoredMcpSession | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(mcpSessions)
        .where(eq(mcpSessions.sessionId, sessionId))
        .for("update")
        .limit(1);
      if (row === undefined) return undefined;
      const updated = updater(copy(sessionFromRow(row)));
      if (updated === undefined) {
        await transaction
          .delete(mcpSessions)
          .where(eq(mcpSessions.sessionId, sessionId));
        return undefined;
      }
      const values = sessionValues(updated);
      const [persisted] = await transaction
        .update(mcpSessions)
        .set(values)
        .where(eq(mcpSessions.sessionId, sessionId))
        .returning();
      return persisted === undefined
        ? undefined
        : copy(sessionFromRow(persisted));
    });
  }

  async delete(sessionId: string): Promise<boolean> {
    const deleted = await this.#database
      .delete(mcpSessions)
      .where(eq(mcpSessions.sessionId, sessionId))
      .returning({ sessionId: mcpSessions.sessionId });
    return deleted.length > 0;
  }
}
