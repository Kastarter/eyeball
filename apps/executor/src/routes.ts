import { randomUUID } from "node:crypto";
import {
  createErrorEnvelope,
  type ExecutionStatus,
  EyeballError,
  isCanonicalToolName,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { type Context, Hono } from "hono";
import type { DevVaultCredentialProvider } from "./dev-vault.js";
import {
  ExecutionEngine,
  ExecutionRequestError,
  type ListExecutionsQuery,
} from "./engine.js";

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

type ApiKeyringInput =
  | Readonly<Record<string, string>>
  | ReadonlyMap<string, string>;

export interface ExecutorVariables {
  projectId: string;
  requestId: string;
}

type ExecutorContext = Context<{ Variables: ExecutorVariables }>;

export interface ExecutorAppOptions {
  engine?: ExecutionEngine;
  apiKeys?: ApiKeyringInput;
  env?: Readonly<Record<string, string | undefined>>;
  requestIdFactory?: () => string;
  /** Enables the process-local fixture connection route. Never use as a cloud vault. */
  devVault?: DevVaultCredentialProvider;
}

export function parseApiKeyring(
  value: string | undefined,
): Map<string, string> {
  const keyring = new Map<string, string>();
  if (value === undefined || value.trim().length === 0) {
    return keyring;
  }

  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    const separator = entry.indexOf(":");
    if (
      separator <= 0 ||
      separator !== entry.lastIndexOf(":") ||
      separator === entry.length - 1
    ) {
      throw new Error(
        "EYEBALL_API_KEYS entries must use the key:projectId format.",
      );
    }
    const key = entry.slice(0, separator).trim();
    const projectId = entry.slice(separator + 1).trim();
    if (key.length === 0 || projectId.length === 0) {
      throw new Error(
        "EYEBALL_API_KEYS entries must include a key and project ID.",
      );
    }
    if (keyring.has(key)) {
      throw new Error("EYEBALL_API_KEYS must not contain duplicate keys.");
    }
    keyring.set(key, projectId);
  }
  return keyring;
}

function materializeKeyring(input: ApiKeyringInput): Map<string, string> {
  if (input instanceof Map) {
    return new Map(input);
  }
  return new Map(Object.entries(input));
}

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/iu.exec(header.trim());
  return match?.[1];
}

function requestFailure(
  context: ExecutorContext,
  error: EyeballError,
  status: 401 | 404 | 409 | 422 | 500,
): Response {
  return context.json(
    createErrorEnvelope(error, context.get("requestId")),
    status,
  );
}

function invalidQuery(context: ExecutorContext, message: string): Response {
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message,
    }),
    422,
  );
}

function handleRouteError(context: ExecutorContext, error: unknown): Response {
  if (error instanceof ExecutionRequestError) {
    return requestFailure(context, error, error.httpStatus);
  }
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "The executor encountered an internal error.",
      retryable: false,
      cause: error,
    }),
    500,
  );
}

function parseListQuery(
  context: ExecutorContext,
): ListExecutionsQuery | Response {
  const statusValue = context.req.query("status");
  if (
    statusValue !== undefined &&
    !EXECUTION_STATUSES.has(statusValue as ExecutionStatus)
  ) {
    return invalidQuery(
      context,
      "status must be pending, running, succeeded, or failed.",
    );
  }
  const toolValue = context.req.query("tool");
  if (toolValue !== undefined && !isCanonicalToolName(toolValue)) {
    return invalidQuery(
      context,
      "tool must be a qualified canonical tool name.",
    );
  }
  const userId = context.req.query("userId");
  if (userId !== undefined && userId.trim().length === 0) {
    return invalidQuery(context, "userId must not be empty.");
  }
  const limitValue = context.req.query("limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  ) {
    return invalidQuery(
      context,
      "limit must be an integer from 1 through 100.",
    );
  }

  const cursor = context.req.query("cursor");
  return {
    ...(statusValue === undefined
      ? {}
      : { status: statusValue as ExecutionStatus }),
    ...(toolValue === undefined
      ? {}
      : { tool: toolValue as QualifiedToolName }),
    ...(userId === undefined ? {} : { userId }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function createExecutorApp(options: ExecutorAppOptions = {}): Hono<{
  Variables: ExecutorVariables;
}> {
  const env = options.env ?? process.env;
  const engine =
    options.engine ??
    new ExecutionEngine({
      env,
      ...(options.devVault === undefined
        ? {}
        : { credentialProvider: options.devVault }),
    });
  if (
    options.devVault !== undefined &&
    engine.credentialProvider !== options.devVault
  ) {
    throw new Error(
      "The executor engine and dev-vault route must use the same credential provider.",
    );
  }
  const keyring =
    options.apiKeys === undefined
      ? parseApiKeyring(env.EYEBALL_API_KEYS)
      : materializeKeyring(options.apiKeys);
  const requestIdFactory =
    options.requestIdFactory ??
    (() => `req_${randomUUID().replaceAll("-", "")}`);
  const app = new Hono<{ Variables: ExecutorVariables }>();

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "executor" }),
  );

  app.use("/v1/*", async (context, next) => {
    context.set("requestId", requestIdFactory());
    const token = bearerToken(context.req.header("Authorization"));
    const projectId = token === undefined ? undefined : keyring.get(token);
    if (projectId === undefined) {
      return requestFailure(
        context,
        new EyeballError({
          code: TOOL_ERROR_CODES.AUTH_MISSING,
          message: "A valid Eyeball API key is required.",
        }),
        401,
      );
    }
    context.set("projectId", projectId);
    await next();
  });

  app.post("/v1/execute", async (context) => {
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }

    try {
      const idempotencyKey = context.req.header("Idempotency-Key");
      const outcome = await engine.execute({
        projectId: context.get("projectId"),
        request,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
      return context.json(outcome.response, outcome.statusCode);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  const devVault = options.devVault;
  if (devVault !== undefined) {
    // Development-only fixture route. Real connection/OAuth lifecycle is private cloud.
    app.post("/v1/connections", async (context) => {
      let request: unknown;
      try {
        request = await context.req.json();
      } catch {
        return invalidQuery(context, "Request body must be valid JSON.");
      }
      if (
        typeof request !== "object" ||
        request === null ||
        Array.isArray(request)
      ) {
        return invalidQuery(
          context,
          "Connection request must be a JSON object.",
        );
      }
      const record = request as Readonly<Record<string, unknown>>;
      const unknownKey = Object.keys(record).find(
        (key) => key !== "userId" && key !== "toolkit",
      );
      if (unknownKey !== undefined) {
        return invalidQuery(
          context,
          `Unknown connection request field: ${unknownKey}.`,
        );
      }
      if (
        typeof record.userId !== "string" ||
        record.userId.trim().length === 0
      ) {
        return invalidQuery(context, "userId must be a non-empty string.");
      }
      if (
        typeof record.toolkit !== "string" ||
        record.toolkit.trim().length === 0
      ) {
        return invalidQuery(context, "toolkit must be a non-empty string.");
      }

      try {
        const connection = await devVault.createConnection({
          projectId: context.get("projectId"),
          userId: record.userId,
          toolkit: record.toolkit,
        });
        return context.json(
          {
            connectionId: connection.connectionId,
            redirectUrl: connection.redirectUrl,
            status: connection.status,
          },
          201,
        );
      } catch (error) {
        if (error instanceof EyeballError) {
          return requestFailure(context, error, 422);
        }
        return handleRouteError(context, error);
      }
    });
  }

  app.get("/v1/executions", async (context) => {
    const query = parseListQuery(context);
    if (query instanceof Response) {
      return query;
    }
    try {
      const page = await engine.listExecutions(context.get("projectId"), query);
      return context.json(page);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/executions/:id", async (context) => {
    try {
      const execution = await engine.getExecution(
        context.get("projectId"),
        context.req.param("id"),
      );
      return context.json(execution);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  return app;
}
