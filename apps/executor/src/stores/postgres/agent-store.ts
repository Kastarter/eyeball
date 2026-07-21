import { randomUUID } from "node:crypto";
import {
  EyeballError,
  TOOL_ERROR_CODES,
  type VoiceAgentDefinition,
  type VoiceAgentDraft,
  type VoiceAgentSummary,
} from "@eyeball/core";
import type {
  AgentStore,
  VoiceAgentBinding,
  VoiceAgentMessageReceipt,
  VoiceAgentSessionPointer,
} from "@eyeball/toolkits";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { EyeballPostgresDatabase } from "./database.js";
import {
  voiceAgentMessageReceipts,
  voiceAgentNumberBindings,
  voiceAgentRevisions,
  voiceAgentSessionPointers,
  voiceAgents,
} from "./schema.js";

interface PostgresAgentStoreOptions {
  agentIdFactory?: () => string;
  bindingIdFactory?: () => string;
}

class AgentStoreInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStoreInvariantError";
  }
}

function generatedAgentId(): string {
  return `va_${randomUUID().replaceAll("-", "")}`;
}

function generatedBindingId(): string {
  return `binding_${randomUUID().replaceAll("-", "")}`;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function storeError(
  code: "invalid_input" | "not_found",
  message: string,
): never {
  throw new EyeballError({ code, message });
}

function agentWhere(projectId: string, agentId: string) {
  return and(
    eq(voiceAgents.projectId, projectId),
    eq(voiceAgents.agentId, agentId),
  );
}

function revisionWhere(projectId: string, agentId: string, revision: number) {
  return and(
    eq(voiceAgentRevisions.projectId, projectId),
    eq(voiceAgentRevisions.agentId, agentId),
    eq(voiceAgentRevisions.revision, revision),
  );
}

function bindingWhere(projectId: string, phoneNumber: string) {
  return and(
    eq(voiceAgentNumberBindings.projectId, projectId),
    eq(voiceAgentNumberBindings.phoneNumber, phoneNumber),
  );
}

function receiptWhere(
  projectId: string,
  userId: string,
  sessionId: string,
  clientMessageId: string,
) {
  return and(
    eq(voiceAgentMessageReceipts.projectId, projectId),
    eq(voiceAgentMessageReceipts.userId, userId),
    eq(voiceAgentMessageReceipts.sessionId, sessionId),
    eq(voiceAgentMessageReceipts.clientMessageId, clientMessageId),
  );
}

function bindingFromRow(
  row: typeof voiceAgentNumberBindings.$inferSelect,
): VoiceAgentBinding {
  return {
    bindingId: row.bindingId,
    projectId: row.projectId,
    userId: row.userId,
    agentId: row.agentId,
    revision: row.revision,
    phoneNumber: row.phoneNumber,
    transportConnectionId: row.transportConnectionId,
    createdAt: isoTimestamp(row.createdAt),
  };
}

function pointerFromRow(
  row: typeof voiceAgentSessionPointers.$inferSelect,
): VoiceAgentSessionPointer {
  return {
    sessionId: row.sessionId,
    projectId: row.projectId,
    userId: row.userId,
    agentId: row.agentId,
    agentRevision: row.agentRevision,
    callId: row.callId,
    createdAt: isoTimestamp(row.createdAt),
  };
}

function receiptFromRow(
  row: typeof voiceAgentMessageReceipts.$inferSelect,
): VoiceAgentMessageReceipt {
  return {
    sessionId: row.sessionId,
    clientMessageId: row.clientMessageId,
    message: row.message,
    userMessageId: row.userMessageId,
    assistantMessage: row.assistantMessage,
  };
}

function exactBinding(
  binding: VoiceAgentBinding,
  input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
): boolean {
  return (
    binding.projectId === input.projectId &&
    binding.userId === input.userId &&
    binding.agentId === input.agentId &&
    binding.revision === input.revision &&
    binding.phoneNumber === input.phoneNumber &&
    binding.transportConnectionId === input.transportConnectionId
  );
}

/** Durable RFC 002 agent resources, immutable revisions, and session metadata. */
export class PostgresAgentStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements AgentStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;
  readonly #agentIdFactory: () => string;
  readonly #bindingIdFactory: () => string;

  constructor(
    database: EyeballPostgresDatabase<TQueryResult>,
    options: PostgresAgentStoreOptions = {},
  ) {
    this.#database = database;
    this.#agentIdFactory = options.agentIdFactory ?? generatedAgentId;
    this.#bindingIdFactory = options.bindingIdFactory ?? generatedBindingId;
  }

  async createAgent(
    projectId: string,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition> {
    return this.#safe(async () => {
      const id = this.#agentIdFactory();
      const definition: VoiceAgentDefinition = {
        ...copy(draft),
        id,
        revision: 1,
        createdAt,
      };
      await this.#database.transaction(async (transaction) => {
        await transaction.insert(voiceAgents).values({
          projectId,
          agentId: id,
          activeRevision: 1,
          createdAt,
          updatedAt: createdAt,
        });
        await transaction.insert(voiceAgentRevisions).values({
          projectId,
          agentId: id,
          revision: 1,
          definition: copy(definition),
          createdAt,
        });
      });
      return copy(definition);
    });
  }

  async getAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition> {
    return this.#safe(async () => {
      const [head] = await this.#database
        .select({ activeRevision: voiceAgents.activeRevision })
        .from(voiceAgents)
        .where(agentWhere(projectId, agentId))
        .limit(1);
      if (head === undefined) {
        return storeError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `Voice agent ${agentId} was not found.`,
        );
      }
      const resolvedRevision = revision ?? head.activeRevision;
      const [row] = await this.#database
        .select({ definition: voiceAgentRevisions.definition })
        .from(voiceAgentRevisions)
        .where(revisionWhere(projectId, agentId, resolvedRevision))
        .limit(1);
      if (row === undefined) {
        return storeError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `Voice agent ${agentId} revision ${resolvedRevision} was not found.`,
        );
      }
      return copy(row.definition);
    });
  }

  async getRunnableAgent(
    projectId: string,
    agentId: string,
    revision?: number,
  ): Promise<VoiceAgentDefinition> {
    return this.#safe(async () => {
      const [head] = await this.#database
        .select({ deletedAt: voiceAgents.deletedAt })
        .from(voiceAgents)
        .where(agentWhere(projectId, agentId))
        .limit(1);
      if (head === undefined) {
        return storeError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `Voice agent ${agentId} was not found.`,
        );
      }
      if (head.deletedAt !== null) {
        return storeError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `Voice agent ${agentId} is deleted and cannot start new sessions.`,
        );
      }
      return await this.getAgent(projectId, agentId, revision);
    });
  }

  async listAgents(
    projectId: string,
    includeDeleted: boolean,
  ): Promise<readonly VoiceAgentSummary[]> {
    return this.#safe(async () => {
      const rows = await this.#database
        .select({
          agentId: voiceAgents.agentId,
          activeRevision: voiceAgents.activeRevision,
          createdAt: voiceAgents.createdAt,
          updatedAt: voiceAgents.updatedAt,
          deletedAt: voiceAgents.deletedAt,
          definition: voiceAgentRevisions.definition,
        })
        .from(voiceAgents)
        .innerJoin(
          voiceAgentRevisions,
          and(
            eq(voiceAgentRevisions.projectId, voiceAgents.projectId),
            eq(voiceAgentRevisions.agentId, voiceAgents.agentId),
            eq(voiceAgentRevisions.revision, voiceAgents.activeRevision),
          ),
        )
        .where(
          includeDeleted
            ? eq(voiceAgents.projectId, projectId)
            : and(
                eq(voiceAgents.projectId, projectId),
                isNull(voiceAgents.deletedAt),
              ),
        )
        .orderBy(asc(voiceAgents.createdAt), asc(voiceAgents.agentId));
      return rows.map((row) =>
        copy({
          id: row.agentId,
          activeRevision: row.activeRevision,
          name: row.definition.name,
          transport: row.definition.transport,
          ...(row.deletedAt === null
            ? {}
            : { deletedAt: isoTimestamp(row.deletedAt) }),
          createdAt: isoTimestamp(row.createdAt),
          updatedAt: isoTimestamp(row.updatedAt),
        } satisfies VoiceAgentSummary),
      );
    });
  }

  async updateAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    draft: VoiceAgentDraft,
    createdAt: string,
  ): Promise<VoiceAgentDefinition> {
    return this.#safe(() =>
      this.#database.transaction(async (transaction) => {
        const [head] = await transaction
          .select()
          .from(voiceAgents)
          .where(agentWhere(projectId, agentId))
          .for("update")
          .limit(1);
        if (head === undefined) {
          return storeError(
            TOOL_ERROR_CODES.NOT_FOUND,
            `Voice agent ${agentId} was not found.`,
          );
        }
        if (head.deletedAt !== null) {
          return storeError(
            TOOL_ERROR_CODES.NOT_FOUND,
            `Voice agent ${agentId} is deleted and cannot be updated.`,
          );
        }
        if (head.activeRevision !== expectedRevision) {
          return storeError(
            TOOL_ERROR_CODES.INVALID_INPUT,
            `Voice agent ${agentId} is at revision ${head.activeRevision}; expected ${expectedRevision}.`,
          );
        }
        const revision = head.activeRevision + 1;
        const definition: VoiceAgentDefinition = {
          ...copy(draft),
          id: agentId,
          revision,
          createdAt,
        };
        await transaction.insert(voiceAgentRevisions).values({
          projectId,
          agentId,
          revision,
          definition: copy(definition),
          createdAt,
        });
        await transaction
          .update(voiceAgents)
          .set({ activeRevision: revision, updatedAt: createdAt })
          .where(agentWhere(projectId, agentId));
        return copy(definition);
      }),
    );
  }

  async deleteAgent(
    projectId: string,
    agentId: string,
    expectedRevision: number,
    deletedAt: string,
  ): Promise<{ agentId: string; deletedAt: string }> {
    return this.#safe(() =>
      this.#database.transaction(async (transaction) => {
        const [head] = await transaction
          .select()
          .from(voiceAgents)
          .where(agentWhere(projectId, agentId))
          .for("update")
          .limit(1);
        if (head === undefined) {
          return storeError(
            TOOL_ERROR_CODES.NOT_FOUND,
            `Voice agent ${agentId} was not found.`,
          );
        }
        if (head.deletedAt !== null) {
          return { agentId, deletedAt: isoTimestamp(head.deletedAt) };
        }
        if (head.activeRevision !== expectedRevision) {
          return storeError(
            TOOL_ERROR_CODES.INVALID_INPUT,
            `Voice agent ${agentId} is at revision ${head.activeRevision}; expected ${expectedRevision}.`,
          );
        }
        await transaction
          .update(voiceAgents)
          .set({ deletedAt, updatedAt: deletedAt })
          .where(agentWhere(projectId, agentId));
        return { agentId, deletedAt };
      }),
    );
  }

  async attachNumber(
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
    createdAt: string,
  ): Promise<VoiceAgentBinding> {
    return this.#safe(async () => {
      const existing = await this.#getNumberBinding(
        input.projectId,
        input.phoneNumber,
      );
      if (existing !== undefined) return this.#resolveBinding(existing, input);

      await this.#database
        .insert(voiceAgentNumberBindings)
        .values({
          projectId: input.projectId,
          phoneNumber: input.phoneNumber,
          bindingId: this.#bindingIdFactory(),
          userId: input.userId,
          agentId: input.agentId,
          revision: input.revision,
          transportConnectionId: input.transportConnectionId,
          createdAt,
        })
        .onConflictDoNothing();
      const winner = await this.#getNumberBinding(
        input.projectId,
        input.phoneNumber,
      );
      if (winner === undefined) {
        throw new Error("Number binding insert had no winning row.");
      }
      return this.#resolveBinding(winner, input);
    });
  }

  async getNumberBinding(
    projectId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined> {
    return this.#safe(() => this.#getNumberBinding(projectId, phoneNumber));
  }

  async listNumberBindings(
    projectId: string,
  ): Promise<readonly VoiceAgentBinding[]> {
    return this.#safe(async () => {
      const rows = await this.#database
        .select()
        .from(voiceAgentNumberBindings)
        .where(eq(voiceAgentNumberBindings.projectId, projectId))
        .orderBy(
          asc(voiceAgentNumberBindings.phoneNumber),
          asc(voiceAgentNumberBindings.bindingId),
        );
      return rows.map((row) => copy(bindingFromRow(row)));
    });
  }

  async detachNumber(
    projectId: string,
    userId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined> {
    return this.#safe(() =>
      this.#database.transaction(async (transaction) => {
        const [row] = await transaction
          .select()
          .from(voiceAgentNumberBindings)
          .where(bindingWhere(projectId, phoneNumber))
          .for("update")
          .limit(1);
        if (row === undefined) return undefined;
        if (row.userId !== userId) {
          return storeError(
            TOOL_ERROR_CODES.NOT_FOUND,
            `Phone number ${phoneNumber} has no binding in the trusted user scope.`,
          );
        }
        await transaction
          .delete(voiceAgentNumberBindings)
          .where(bindingWhere(projectId, phoneNumber));
        return copy(bindingFromRow(row));
      }),
    );
  }

  async rememberSession(pointer: VoiceAgentSessionPointer): Promise<void> {
    await this.#safe(() =>
      this.#database.transaction(async (transaction) => {
        await transaction
          .insert(voiceAgentSessionPointers)
          .values(copy(pointer))
          .onConflictDoNothing({
            target: voiceAgentSessionPointers.sessionId,
          });
        const [existing] = await transaction
          .select()
          .from(voiceAgentSessionPointers)
          .where(eq(voiceAgentSessionPointers.sessionId, pointer.sessionId))
          .for("update")
          .limit(1);
        if (
          existing !== undefined &&
          (existing.projectId !== pointer.projectId ||
            existing.userId !== pointer.userId)
        ) {
          throw new AgentStoreInvariantError(
            "AgentStore invariant violated: session scope changed.",
          );
        }
        if (existing === undefined) {
          throw new AgentStoreInvariantError(
            "AgentStore invariant violated: session pointer disappeared.",
          );
        }
        await transaction
          .update(voiceAgentSessionPointers)
          .set({
            agentId: pointer.agentId,
            agentRevision: pointer.agentRevision,
            callId: pointer.callId,
            createdAt: pointer.createdAt,
          })
          .where(eq(voiceAgentSessionPointers.sessionId, pointer.sessionId));
      }),
    );
  }

  async getSession(
    projectId: string,
    userId: string,
    sessionId: string,
  ): Promise<VoiceAgentSessionPointer> {
    return this.#safe(async () => {
      const [row] = await this.#database
        .select()
        .from(voiceAgentSessionPointers)
        .where(eq(voiceAgentSessionPointers.sessionId, sessionId))
        .limit(1);
      if (
        row === undefined ||
        row.projectId !== projectId ||
        row.userId !== userId
      ) {
        return storeError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `Voice-agent session ${sessionId} was not found in the trusted scope.`,
        );
      }
      return copy(pointerFromRow(row));
    });
  }

  async listSessions(
    projectId: string,
    userId: string,
  ): Promise<readonly VoiceAgentSessionPointer[]> {
    return this.#safe(async () => {
      const rows = await this.#database
        .select()
        .from(voiceAgentSessionPointers)
        .where(
          and(
            eq(voiceAgentSessionPointers.projectId, projectId),
            eq(voiceAgentSessionPointers.userId, userId),
          ),
        )
        .orderBy(
          desc(voiceAgentSessionPointers.createdAt),
          desc(voiceAgentSessionPointers.sessionId),
        );
      return rows.map((row) => copy(pointerFromRow(row)));
    });
  }

  async getMessage(
    projectId: string,
    userId: string,
    sessionId: string,
    clientMessageId: string,
  ): Promise<VoiceAgentMessageReceipt | undefined> {
    return this.#safe(async () => {
      const [row] = await this.#database
        .select()
        .from(voiceAgentMessageReceipts)
        .where(receiptWhere(projectId, userId, sessionId, clientMessageId))
        .limit(1);
      return row === undefined ? undefined : copy(receiptFromRow(row));
    });
  }

  async rememberMessage(
    projectId: string,
    userId: string,
    receipt: VoiceAgentMessageReceipt,
  ): Promise<void> {
    await this.#safe(async () => {
      await this.#database
        .insert(voiceAgentMessageReceipts)
        .values({ projectId, userId, ...copy(receipt) })
        .onConflictDoUpdate({
          target: [
            voiceAgentMessageReceipts.projectId,
            voiceAgentMessageReceipts.userId,
            voiceAgentMessageReceipts.sessionId,
            voiceAgentMessageReceipts.clientMessageId,
          ],
          set: {
            message: receipt.message,
            userMessageId: receipt.userMessageId,
            assistantMessage: receipt.assistantMessage,
          },
        });
    });
  }

  async #getNumberBinding(
    projectId: string,
    phoneNumber: string,
  ): Promise<VoiceAgentBinding | undefined> {
    const [row] = await this.#database
      .select()
      .from(voiceAgentNumberBindings)
      .where(bindingWhere(projectId, phoneNumber))
      .limit(1);
    return row === undefined ? undefined : copy(bindingFromRow(row));
  }

  #resolveBinding(
    existing: VoiceAgentBinding,
    input: Omit<VoiceAgentBinding, "bindingId" | "createdAt">,
  ): VoiceAgentBinding {
    if (exactBinding(existing, input)) return copy(existing);
    return storeError(
      TOOL_ERROR_CODES.INVALID_INPUT,
      `Phone number ${input.phoneNumber} already has a different voice-agent binding.`,
    );
  }

  async #safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof EyeballError ||
        error instanceof AgentStoreInvariantError
      ) {
        throw error;
      }
      throw new Error("Voice-agent persistence failed.");
    }
  }
}
