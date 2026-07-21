import { createHash } from "node:crypto";
import {
  type ApiKeyPrincipal,
  type ApiKeyringInput,
  materializeApiKeyring,
  parseApiKeyring,
} from "@eyeball/core";
import { type Context, Hono } from "hono";
import { HttpMcpExecutor, type McpExecutor } from "./executor.js";
import {
  type GatewayCatalog,
  type JsonRpcNotification,
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  type McpClock,
  McpProtocol,
  parseJsonRpc,
  type ToolDiscoveryMode,
} from "./protocol.js";
import { InMemorySessionStore, type SessionStore } from "./session-store.js";
import {
  createPgMcpGatewayStoreBundle,
  type PgMcpGatewayStoreBundle,
} from "./stores/postgres/factory.js";

const DEFAULT_EXECUTOR_URL = "http://127.0.0.1:3000";
const USER_ID_HEADER = "X-Eyeball-User-Id";
const SESSION_ID_HEADER = "Mcp-Session-Id";
const PROTOCOL_VERSION_HEADER = "MCP-Protocol-Version";

export interface McpGatewayOptions {
  executor?: McpExecutor;
  executorBaseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  apiKey?: string;
  /** Optional inbound keyring; values may pin a key to one end user. */
  apiKeys?: ApiKeyringInput;
  /** Separate executor credential used only after inbound authentication succeeds. */
  executorApiKey?: string;
  userId?: string;
  discoveryMode?: ToolDiscoveryMode;
  catalog?: GatewayCatalog;
  sessionStore?: SessionStore;
  clock?: McpClock;
  taskPollMs?: number;
  taskTtlMs?: number;
  sessionTtlMs?: number;
  /** Browser origins allowed to call /mcp. Requests without Origin remain valid. */
  allowedOrigins?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  sessionIdFactory?: () => string;
  eventIdFactory?: () => string;
}

export interface McpGatewayPersistence {
  sessionStore: SessionStore;
  close(): Promise<void>;
}

export interface McpGatewayRuntime {
  app: Hono;
  sessionStore: SessionStore;
  persistence?: McpGatewayPersistence;
  dispose(): void;
  close(): Promise<void>;
}

export interface McpGatewayRuntimeOptions extends McpGatewayOptions {
  persistenceFactory?: (
    connectionString: string,
  ) => Promise<McpGatewayPersistence>;
}

interface AuthenticatedRequest {
  executorApiKey: string;
  authBinding: string;
  principal?: ApiKeyPrincipal;
  requestUserId?: string;
}

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return /^Bearer ([^\s]+)$/iu.exec(value.trim())?.[1];
}

function discoveryMode(value: string | undefined): ToolDiscoveryMode {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === undefined ||
    normalized === "" ||
    normalized === "catalog"
  ) {
    return "catalog";
  }
  if (normalized === "search") {
    return "search";
  }
  throw new Error(
    'EYEBALL_MCP_DISCOVERY must be either "catalog" or "search".',
  );
}

function optionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function configuredOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function unauthorized(context: Context): Response {
  context.header("WWW-Authenticate", "Bearer");
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "A valid Eyeball API key is required." },
    },
    401,
  );
}

function forbidden(context: Context): Response {
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32003,
        message: "This API key is pinned to a different end user.",
      },
    },
    403,
  );
}

function forbiddenOrigin(context: Context): Response {
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32003, message: "Origin is not allowed." },
    },
    403,
  );
}

function sessionNotFound(context: Context): Response {
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32004, message: "MCP session not found." },
    },
    404,
  );
}

function missingSession(context: Context): Response {
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Mcp-Session-Id is required." },
    },
    400,
  );
}

function methodNotAllowed(context: Context): Response {
  context.header("Allow", "POST, GET, DELETE");
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "This MCP transport operation is not available.",
      },
    },
    405,
  );
}

function accepts(value: string | undefined, mediaType: string): boolean {
  return (
    value
      ?.split(",")
      .some((entry) => entry.trim().split(";", 1)[0] === mediaType) ?? false
  );
}

function requestMethod(value: unknown): string | undefined {
  return typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof value.method === "string"
    ? value.method
    : undefined;
}

function isNotification(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    !("id" in value)
  );
}

function requestId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }
  return typeof value.id === "string" ||
    typeof value.id === "number" ||
    value.id === null
    ? value.id
    : null;
}

function authFingerprint(
  apiKey: string,
  projectId: string | undefined,
  userId: string | undefined,
): string {
  const authorityScope = JSON.stringify([
    "eyeball-mcp-session-auth-v2",
    apiKey,
    projectId ?? null,
    userId ?? null,
  ]);
  return createHash("sha256").update(authorityScope).digest("base64url");
}

function originAllowed(
  context: Context,
  allowedOrigins: readonly string[],
): boolean {
  const origin = context.req.header("Origin");
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}

function protocolVersionError(context: Context): Response | undefined {
  const protocolVersion = context.req.header(PROTOCOL_VERSION_HEADER);
  if (
    protocolVersion === undefined ||
    protocolVersion === MCP_PROTOCOL_VERSION
  ) {
    return undefined;
  }
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `Unsupported MCP protocol version: ${protocolVersion}.`,
      },
    },
    400,
  );
}

function sseHeaders(sessionId?: string): Headers {
  const headers = new Headers({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (sessionId !== undefined) headers.set(SESSION_ID_HEADER, sessionId);
  return headers;
}

function finiteSseResponse(
  protocol: McpProtocol,
  response: JsonRpcResponse,
  sessionId?: string,
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`id: ${protocol.nextEventId(sessionId)}\ndata:\n\n`),
        );
        controller.enqueue(
          encoder.encode(
            `id: ${protocol.nextEventId(sessionId)}\ndata: ${JSON.stringify(response)}\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: sseHeaders(sessionId) },
  );
}

function requestSseResponse(
  protocol: McpProtocol,
  sessionId: string | undefined,
  run: () => Promise<JsonRpcResponse | undefined>,
  fallbackId: string | number | null,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          controller.close();
        };
        const send = (message: JsonRpcResponse | JsonRpcNotification) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `id: ${protocol.nextEventId(sessionId)}\ndata: ${JSON.stringify(message)}\n\n`,
            ),
          );
        };
        controller.enqueue(
          encoder.encode(`id: ${protocol.nextEventId(sessionId)}\ndata:\n\n`),
        );
        if (sessionId !== undefined) {
          unsubscribe = protocol.subscribe(sessionId, (message) => {
            if (message === undefined) close();
            else send(message);
          });
        }
        void run()
          .then((response) => {
            if (response !== undefined) send(response);
            close();
          })
          .catch(() => {
            send({
              jsonrpc: "2.0",
              id: fallbackId,
              error: { code: -32603, message: "Internal error" },
            });
            close();
          });
      },
      cancel() {
        closed = true;
        unsubscribe();
      },
    }),
    { status: 200, headers: sseHeaders(sessionId) },
  );
}

function sessionSseResponse(
  protocol: McpProtocol,
  sessionId: string,
  start: () => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: () => void = () => undefined;
  let closed = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          controller.close();
        };
        controller.enqueue(
          encoder.encode(`id: ${protocol.nextEventId(sessionId)}\ndata:\n\n`),
        );
        unsubscribe = protocol.subscribe(sessionId, (message) => {
          if (message === undefined) {
            close();
            return;
          }
          if (closed) return;
          controller.enqueue(
            encoder.encode(
              `id: ${protocol.nextEventId(sessionId)}\ndata: ${JSON.stringify(message)}\n\n`,
            ),
          );
        });
        void start().catch(close);
      },
      cancel() {
        closed = true;
        unsubscribe();
      },
    }),
    { status: 200, headers: sseHeaders(sessionId) },
  );
}

function createMcpGatewayComposition(options: McpGatewayOptions = {}): {
  app: Hono;
  protocol: McpProtocol;
} {
  const env = options.env ?? process.env;
  const configuredApiKey = options.apiKey ?? env.EYEBALL_API_KEY;
  const downstreamApiKey =
    options.executorApiKey ?? env.EYEBALL_EXECUTOR_API_KEY;
  const apiKeys =
    options.apiKeys === undefined
      ? parseApiKeyring(env.EYEBALL_API_KEYS)
      : materializeApiKeyring(options.apiKeys);
  if (
    downstreamApiKey !== undefined &&
    apiKeys.size === 0 &&
    configuredApiKey === undefined
  ) {
    throw new Error(
      "EYEBALL_EXECUTOR_API_KEY requires an inbound EYEBALL_API_KEYS policy.",
    );
  }
  const configuredUserId = options.userId ?? env.EYEBALL_USER_ID;
  const allowedOrigins =
    options.allowedOrigins ??
    configuredOrigins(env.EYEBALL_MCP_ALLOWED_ORIGINS);
  const executor =
    options.executor ??
    new HttpMcpExecutor({
      baseUrl:
        options.executorBaseUrl ??
        env.EYEBALL_EXECUTOR_URL ??
        DEFAULT_EXECUTOR_URL,
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
    });
  const taskPollMs =
    options.taskPollMs ??
    optionalPositiveInteger(
      env.EYEBALL_MCP_TASK_POLL_MS,
      "EYEBALL_MCP_TASK_POLL_MS",
    );
  const taskTtlMs =
    options.taskTtlMs ??
    optionalPositiveInteger(
      env.EYEBALL_MCP_TASK_TTL_MS,
      "EYEBALL_MCP_TASK_TTL_MS",
    );
  const sessionTtlMs =
    options.sessionTtlMs ??
    optionalPositiveInteger(
      env.EYEBALL_MCP_SESSION_TTL_MS,
      "EYEBALL_MCP_SESSION_TTL_MS",
    );
  const protocol = new McpProtocol({
    executor,
    discoveryMode:
      options.discoveryMode ?? discoveryMode(env.EYEBALL_MCP_DISCOVERY),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.sessionStore === undefined
      ? {}
      : { sessionStore: options.sessionStore }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(taskPollMs === undefined ? {} : { taskPollMs }),
    ...(taskTtlMs === undefined ? {} : { taskTtlMs }),
    ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
    ...(options.sessionIdFactory === undefined
      ? {}
      : { sessionIdFactory: options.sessionIdFactory }),
    ...(options.eventIdFactory === undefined
      ? {}
      : { eventIdFactory: options.eventIdFactory }),
  });
  const app = new Hono();

  const authenticate = (context: Context): AuthenticatedRequest | Response => {
    const inboundApiKey = bearerToken(context.req.header("Authorization"));
    if (inboundApiKey === undefined || inboundApiKey.trim().length === 0) {
      return unauthorized(context);
    }
    let principal: ApiKeyPrincipal | undefined;
    if (apiKeys.size > 0) {
      principal = apiKeys.get(inboundApiKey);
      if (principal === undefined) return unauthorized(context);
    } else if (
      configuredApiKey !== undefined &&
      inboundApiKey !== configuredApiKey
    ) {
      return unauthorized(context);
    }
    const requestUserId =
      configuredUserId ?? context.req.header(USER_ID_HEADER);
    if (
      principal?.userId !== undefined &&
      requestUserId !== undefined &&
      requestUserId !== principal.userId
    ) {
      return forbidden(context);
    }
    return {
      executorApiKey: downstreamApiKey ?? inboundApiKey,
      authBinding: authFingerprint(
        inboundApiKey,
        principal?.projectId,
        principal?.userId ?? configuredUserId,
      ),
      ...(principal === undefined ? {} : { principal }),
      ...(requestUserId === undefined ? {} : { requestUserId }),
    };
  };

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "mcp-gateway" }),
  );

  app.get("/mcp", async (context) => {
    if (!originAllowed(context, allowedOrigins))
      return forbiddenOrigin(context);
    if (!accepts(context.req.header("Accept"), "text/event-stream")) {
      return methodNotAllowed(context);
    }
    const authenticated = authenticate(context);
    if (authenticated instanceof Response) return authenticated;
    const versionError = protocolVersionError(context);
    if (versionError !== undefined) return versionError;
    const sessionId = context.req.header(SESSION_ID_HEADER);
    if (sessionId === undefined) return missingSession(context);
    const resolved = await protocol.resolveSession(
      sessionId,
      authenticated.authBinding,
    );
    if (resolved.kind !== "active") return sessionNotFound(context);
    const requestContext = {
      apiKey: authenticated.executorApiKey,
      authBinding: authenticated.authBinding,
      sessionId,
      ...(authenticated.requestUserId === undefined
        ? {}
        : { userId: authenticated.requestUserId }),
      ...(authenticated.principal?.userId === undefined
        ? {}
        : { pinnedUserId: authenticated.principal.userId }),
    };
    return sessionSseResponse(protocol, sessionId, async () => {
      await protocol.checkCatalogVersion(sessionId, authenticated.authBinding);
      await protocol.resumeTasks(requestContext);
    });
  });

  app.delete("/mcp", async (context) => {
    if (!originAllowed(context, allowedOrigins))
      return forbiddenOrigin(context);
    const authenticated = authenticate(context);
    if (authenticated instanceof Response) return authenticated;
    const versionError = protocolVersionError(context);
    if (versionError !== undefined) return versionError;
    const sessionId = context.req.header(SESSION_ID_HEADER);
    if (sessionId === undefined) return missingSession(context);
    const deleted = await protocol.deleteSession(
      sessionId,
      authenticated.authBinding,
    );
    return deleted ? context.body(null, 204) : sessionNotFound(context);
  });

  app.post("/mcp", async (context) => {
    if (!originAllowed(context, allowedOrigins))
      return forbiddenOrigin(context);
    const authenticated = authenticate(context);
    if (authenticated instanceof Response) return authenticated;
    const versionError = protocolVersionError(context);
    if (versionError !== undefined) return versionError;

    const parsed = parseJsonRpc(await context.req.text());
    if (!parsed.ok) {
      return context.json(parsed.response, 400);
    }
    const method = requestMethod(parsed.value);
    const sessionId = context.req.header(SESSION_ID_HEADER);
    if (method === "initialize" && sessionId !== undefined) {
      return context.json(
        {
          jsonrpc: "2.0",
          id: requestId(parsed.value),
          error: {
            code: -32600,
            message: "Initialize requests must not include Mcp-Session-Id.",
          },
        },
        400,
      );
    }
    let activeSession = false;
    if (sessionId !== undefined) {
      const resolved = await protocol.resolveSession(
        sessionId,
        authenticated.authBinding,
      );
      if (resolved.kind !== "active") return sessionNotFound(context);
      activeSession = true;
    }

    const requestContext = {
      apiKey: authenticated.executorApiKey,
      authBinding: authenticated.authBinding,
      ...(authenticated.requestUserId === undefined
        ? {}
        : { userId: authenticated.requestUserId }),
      ...(authenticated.principal?.userId === undefined
        ? {}
        : { pinnedUserId: authenticated.principal.userId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    const run = async (): Promise<JsonRpcResponse | undefined> => {
      if (sessionId !== undefined && activeSession) {
        await protocol.checkCatalogVersion(
          sessionId,
          authenticated.authBinding,
        );
        await protocol.resumeTasks(requestContext);
      }
      return (await protocol.handle(parsed.value, requestContext)).response;
    };

    if (isNotification(parsed.value)) {
      await run();
      return context.body(null, 202);
    }

    const wantsSse = accepts(context.req.header("Accept"), "text/event-stream");
    if (method === "initialize") {
      const result = await protocol.handle(parsed.value, requestContext);
      if (result.response === undefined) return context.body(null, 202);
      if (wantsSse) {
        return finiteSseResponse(protocol, result.response, result.sessionId);
      }
      if (result.sessionId !== undefined) {
        context.header(SESSION_ID_HEADER, result.sessionId);
      }
      return context.json(result.response);
    }
    if (wantsSse) {
      return requestSseResponse(
        protocol,
        sessionId,
        run,
        requestId(parsed.value),
      );
    }
    const response = await run();
    return response === undefined
      ? context.body(null, 202)
      : context.json(response);
  });

  app.all("/mcp", (context) =>
    originAllowed(context, allowedOrigins)
      ? methodNotAllowed(context)
      : forbiddenOrigin(context),
  );

  return { app, protocol };
}

export function createMcpGatewayApp(options: McpGatewayOptions = {}): Hono {
  return createMcpGatewayComposition(options).app;
}

/**
 * Builds the stock gateway composition. Direct app construction stays synchronous
 * and in-memory, while the server opts into durable sessions when a database URL
 * is configured.
 */
export async function createMcpGatewayRuntime(
  options: McpGatewayRuntimeOptions = {},
): Promise<McpGatewayRuntime> {
  const { persistenceFactory, ...appOptions } = options;
  const env = appOptions.env ?? process.env;
  let persistence: McpGatewayPersistence | undefined;
  const sessionStore =
    appOptions.sessionStore ??
    (await (async (): Promise<SessionStore> => {
      const connectionString = env.EYEBALL_DATABASE_URL?.trim();
      if (connectionString === undefined || connectionString.length === 0) {
        return new InMemorySessionStore();
      }
      const factory =
        persistenceFactory ??
        (async (value: string): Promise<PgMcpGatewayStoreBundle> =>
          createPgMcpGatewayStoreBundle({ connectionString: value }));
      persistence = await factory(connectionString);
      return persistence.sessionStore;
    })());

  let composition: ReturnType<typeof createMcpGatewayComposition>;
  try {
    composition = createMcpGatewayComposition({ ...appOptions, sessionStore });
  } catch (error) {
    await persistence?.close();
    throw error;
  }

  const { app, protocol } = composition;
  let closePromise: Promise<void> | undefined;
  const dispose = (): void => protocol.dispose();
  const runtime: McpGatewayRuntime = {
    app,
    sessionStore,
    ...(persistence === undefined ? {} : { persistence }),
    dispose,
    close: () => {
      dispose();
      closePromise ??= persistence?.close() ?? Promise.resolve();
      return closePromise;
    },
  };
  return runtime;
}

export * from "./executor.js";
export * from "./protocol.js";
export * from "./search-tool.js";
export * from "./session-store.js";
export * from "./stores/postgres/index.js";

export const app = createMcpGatewayApp();
