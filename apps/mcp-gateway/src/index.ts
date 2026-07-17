import {
  type ApiKeyPrincipal,
  type ApiKeyringInput,
  materializeApiKeyring,
  parseApiKeyring,
} from "@eyeball/core";
import { type Context, Hono } from "hono";
import { HttpMcpExecutor, type McpExecutor } from "./executor.js";
import {
  MCP_PROTOCOL_VERSION,
  McpProtocol,
  parseJsonRpc,
  type ToolDiscoveryMode,
} from "./protocol.js";

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
  env?: Readonly<Record<string, string | undefined>>;
  sessionIdFactory?: () => string;
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

function methodNotAllowed(context: Context): Response {
  context.header("Allow", "POST");
  return context.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "Streamable HTTP requests must use POST.",
      },
    },
    405,
  );
}

export function createMcpGatewayApp(options: McpGatewayOptions = {}): Hono {
  const env = options.env ?? process.env;
  const configuredApiKey = options.apiKey ?? env.EYEBALL_API_KEY;
  const executorApiKey = options.executorApiKey ?? env.EYEBALL_EXECUTOR_API_KEY;
  const apiKeys =
    options.apiKeys === undefined
      ? parseApiKeyring(env.EYEBALL_API_KEYS)
      : materializeApiKeyring(options.apiKeys);
  if (
    executorApiKey !== undefined &&
    apiKeys.size === 0 &&
    configuredApiKey === undefined
  ) {
    throw new Error(
      "EYEBALL_EXECUTOR_API_KEY requires an inbound EYEBALL_API_KEYS policy.",
    );
  }
  const configuredUserId = options.userId ?? env.EYEBALL_USER_ID;
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
  const protocol = new McpProtocol({
    executor,
    discoveryMode:
      options.discoveryMode ?? discoveryMode(env.EYEBALL_MCP_DISCOVERY),
    ...(options.sessionIdFactory === undefined
      ? {}
      : { sessionIdFactory: options.sessionIdFactory }),
  });
  const app = new Hono();

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "mcp-gateway" }),
  );

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
  app.post("/mcp", async (context) => {
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
    const apiKey = executorApiKey ?? inboundApiKey;

    const protocolVersion = context.req.header(PROTOCOL_VERSION_HEADER);
    if (
      protocolVersion !== undefined &&
      protocolVersion !== MCP_PROTOCOL_VERSION
    ) {
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

    const parsed = parseJsonRpc(await context.req.text());
    if (!parsed.ok) {
      return context.json(parsed.response, 400);
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
    const requestSessionId = context.req.header(SESSION_ID_HEADER);
    const result = await protocol.handle(parsed.value, {
      apiKey,
      ...(requestUserId === undefined ? {} : { userId: requestUserId }),
      ...(principal?.userId === undefined
        ? {}
        : { pinnedUserId: principal.userId }),
      ...(requestSessionId === undefined
        ? {}
        : { sessionId: requestSessionId }),
    });
    if (result.sessionId !== undefined) {
      context.header(SESSION_ID_HEADER, result.sessionId);
    }
    if (result.response === undefined) {
      return context.body(null, 202);
    }
    return context.json(result.response);
  });

  return app;
}

export * from "./executor.js";
export * from "./protocol.js";
export * from "./search-tool.js";

export const app = createMcpGatewayApp();
