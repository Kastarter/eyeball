import {
  type ConnectionId,
  type CredentialContext,
  type CredentialProvider,
  createConnectionId,
  EyeballError,
  MockCredentialProvider,
  type ResolvedCredential,
  TOOL_ERROR_CODES,
  validateCanonicalToolName,
} from "@eyeball/core";

export interface CreateDevConnectionContext {
  projectId: string;
  userId: string;
  toolkit: string;
}

export type DevConnectionStatus = "connected" | "expired" | "revoked";

export interface DevConnectionSummary {
  connectionId: ConnectionId;
  createdAt: string;
  userId: string;
  toolkit: string;
  status: DevConnectionStatus;
}

export interface DevConnection extends DevConnectionSummary {
  redirectUrl: null;
  status: "connected";
}

/**
 * Development-only seam. Production connection lifecycle and credential storage live in
 * the private eyeball-cloud Auth Vault.
 */
export interface DevVaultCredentialProvider extends CredentialProvider {
  readonly kind: "mock";
  createConnection(context: CreateDevConnectionContext): Promise<DevConnection>;
  listConnections(projectId: string): Promise<readonly DevConnectionSummary[]>;
  revokeConnection(
    projectId: string,
    connectionId: ConnectionId,
  ): Promise<DevConnectionSummary>;
}

export interface InMemoryDevVaultOptions {
  /** Toolkit credential templates; mock secrets must use the `fixture:*` convention. */
  credentials: Readonly<Record<string, ResolvedCredential>>;
  connectionIdFactory?: () => ConnectionId;
  now?: () => Date;
}

interface StoredDevConnection extends DevConnectionSummary {
  projectId: string;
  credential: ResolvedCredential;
  redirectUrl: null;
}

function clonedCredential(credential: ResolvedCredential): ResolvedCredential {
  return structuredClone(credential);
}

function connectionSummary(
  connection: StoredDevConnection,
): DevConnectionSummary {
  return {
    connectionId: connection.connectionId,
    createdAt: connection.createdAt,
    userId: connection.userId,
    toolkit: connection.toolkit,
    status: connection.status,
  };
}

function validateTemplate(
  toolkit: string,
  credential: ResolvedCredential,
): void {
  validateCanonicalToolName(`${toolkit}.catalog_probe`);
  if (credential.connectionId !== undefined) {
    throw new Error(
      `Dev-vault credential template ${toolkit} must not pre-bind a connectionId.`,
    );
  }
  new MockCredentialProvider([
    {
      match: {
        projectId: "dev_vault_validation",
        userId: "dev_vault_validation",
        toolkitSlug: toolkit,
      },
      credential,
    },
  ]);
}

/**
 * Process-local fixture vault for tests and OSS development only. It deliberately relies
 * on `MockCredentialProvider`, including its `fixture:*` secret guardrails and selection
 * semantics; it is not durable, encrypted, refresh-capable, or production-safe.
 */
export class InMemoryDevVault implements DevVaultCredentialProvider {
  readonly kind = "mock" as const;
  readonly #credentials: ReadonlyMap<string, ResolvedCredential>;
  readonly #connectionIdFactory: () => ConnectionId;
  readonly #connections = new Map<ConnectionId, StoredDevConnection>();
  readonly #now: () => Date;

  constructor(options: InMemoryDevVaultOptions) {
    const credentials = new Map<string, ResolvedCredential>();
    for (const [toolkit, credential] of Object.entries(options.credentials)) {
      if (toolkit.trim().length === 0) {
        throw new Error("Dev-vault toolkit names must not be empty.");
      }
      validateTemplate(toolkit, credential);
      credentials.set(toolkit, clonedCredential(credential));
    }
    this.#credentials = credentials;
    this.#connectionIdFactory =
      options.connectionIdFactory ?? createConnectionId;
    this.#now = options.now ?? (() => new Date());
  }

  async createConnection(
    context: CreateDevConnectionContext,
  ): Promise<DevConnection> {
    for (const [field, value] of Object.entries(context)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message: `${field} must not be empty.`,
          retryable: false,
        });
      }
    }
    const credential = this.#credentials.get(context.toolkit);
    if (credential === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message: `The OSS dev vault has no fixture credential for toolkit ${context.toolkit}.`,
        retryable: false,
      });
    }
    const connectionId = this.#connectionIdFactory();
    if (this.#connections.has(connectionId)) {
      throw new Error(`Duplicate dev-vault connection ID: ${connectionId}`);
    }
    const connection: StoredDevConnection = {
      connectionId,
      createdAt: this.#now().toISOString(),
      projectId: context.projectId,
      userId: context.userId,
      toolkit: context.toolkit,
      redirectUrl: null,
      status: "connected",
      credential: clonedCredential(credential),
    };
    this.#connections.set(connectionId, connection);
    return {
      connectionId,
      createdAt: connection.createdAt,
      userId: connection.userId,
      toolkit: connection.toolkit,
      redirectUrl: null,
      status: "connected",
    };
  }

  async listConnections(
    projectId: string,
  ): Promise<readonly DevConnectionSummary[]> {
    return [...this.#connections.values()]
      .filter((connection) => connection.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(connectionSummary);
  }

  async revokeConnection(
    projectId: string,
    connectionId: ConnectionId,
  ): Promise<DevConnectionSummary> {
    const connection = this.#connections.get(connectionId);
    if (connection === undefined || connection.projectId !== projectId) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: `Connection ${connectionId} was not found.`,
        retryable: false,
      });
    }
    connection.status = "revoked";
    return connectionSummary(connection);
  }

  resolve(context: CredentialContext): Promise<ResolvedCredential> {
    const fixtures = [...this.#connections.values()]
      .filter((connection) => connection.status === "connected")
      .map((connection) => ({
        match: {
          projectId: connection.projectId,
          userId: connection.userId,
          toolkitSlug: connection.toolkit,
          connectionId: connection.connectionId,
        },
        credential: {
          ...clonedCredential(connection.credential),
          connectionId: connection.connectionId,
        } as ResolvedCredential,
      }));
    return new MockCredentialProvider(fixtures).resolve(context);
  }
}
