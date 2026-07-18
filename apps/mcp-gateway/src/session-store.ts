import type {
  ExecutionId,
  ExecutionStatus,
  QualifiedToolName,
} from "@eyeball/core";

export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export type McpProgressToken = string | number;

export interface StoredMcpTask {
  taskId: ExecutionId;
  tool: QualifiedToolName;
  executionStatus: ExecutionStatus;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval: number;
  progress: number;
  progressToken?: McpProgressToken;
}

export interface StoredMcpSession {
  sessionId: string;
  protocolVersion: string;
  authBinding: string;
  tasksEnabled: boolean;
  createdAt: string;
  expiresAt: string;
  catalogVersion?: string;
  tasks: Readonly<Record<string, StoredMcpTask>>;
}

/**
 * Persistence boundary for negotiated MCP session state. Implementations must return
 * detached values and apply update() atomically so concurrent task transitions do not
 * overwrite one another.
 */
export interface SessionStore {
  get(sessionId: string): Promise<StoredMcpSession | undefined>;
  set(session: StoredMcpSession): Promise<void>;
  update(
    sessionId: string,
    updater: (session: StoredMcpSession) => StoredMcpSession | undefined,
  ): Promise<StoredMcpSession | undefined>;
  delete(sessionId: string): Promise<boolean>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Process-local default. A durable implementation can be injected without changing protocol code. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, StoredMcpSession>();

  async get(sessionId: string): Promise<StoredMcpSession | undefined> {
    const session = this.#sessions.get(sessionId);
    return session === undefined ? undefined : clone(session);
  }

  async set(session: StoredMcpSession): Promise<void> {
    this.#sessions.set(session.sessionId, clone(session));
  }

  async update(
    sessionId: string,
    updater: (session: StoredMcpSession) => StoredMcpSession | undefined,
  ): Promise<StoredMcpSession | undefined> {
    const existing = this.#sessions.get(sessionId);
    if (existing === undefined) return undefined;
    const updated = updater(clone(existing));
    if (updated === undefined) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    const detached = clone(updated);
    this.#sessions.set(sessionId, detached);
    return clone(detached);
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.#sessions.delete(sessionId);
  }
}
