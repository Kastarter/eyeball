import { randomUUID } from "node:crypto";
import {
  type ApiKeyringInput,
  createErrorEnvelope,
  type ExecutionStatus,
  EyeballError,
  fromRestrictedToolName,
  isCanonicalToolName,
  isConnectionId,
  materializeApiKeyring,
  parseApiKeyring,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { type Context, Hono } from "hono";
import { createConfiguredCredentialProvider } from "./credential-provider.js";
import type { DevVaultCredentialProvider } from "./dev-vault.js";
import type { DevVoiceSessionAdvancer } from "./dev-voice-sessions.js";
import {
  ExecutionEngine,
  ExecutionRequestError,
  type ListExecutionsQuery,
} from "./engine.js";
import type { FileStore } from "./staged-files.js";

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

export { parseApiKeyring } from "@eyeball/core";

const USER_ID_HEADER = "X-Eyeball-User-Id";

export interface ExecutorVariables {
  projectId: string;
  pinnedUserId: string | undefined;
  requestId: string;
}

type ExecutorContext = Context<{ Variables: ExecutorVariables }>;

export interface ExecutorAppOptions {
  engine?: ExecutionEngine;
  fileStore?: FileStore;
  apiKeys?: ApiKeyringInput;
  env?: Readonly<Record<string, string | undefined>>;
  requestIdFactory?: () => string;
  /** Enables the process-local fixture connection route. Never use as a cloud vault. */
  devVault?: DevVaultCredentialProvider;
  /** Enables request-driven mock voice progression; requires devVault. */
  devVoiceSessions?: DevVoiceSessionAdvancer;
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
  status: 401 | 403 | 404 | 409 | 413 | 422 | 500,
): Response {
  return context.json(
    createErrorEnvelope(error, context.get("requestId")),
    status,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    return undefined;
  }
  const content = Buffer.from(value, "base64");
  return content.toString("base64") === value
    ? Uint8Array.from(content)
    : undefined;
}

function pinnedUserFailure(context: ExecutorContext): Response {
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      message: "This API key is pinned to a different end user.",
    }),
    403,
  );
}

function rejectsPinnedUser(
  context: ExecutorContext,
  ...candidates: readonly (string | undefined)[]
): boolean {
  const pinned = context.get("pinnedUserId");
  return (
    pinned !== undefined &&
    candidates.some(
      (candidate) => candidate !== undefined && candidate !== pinned,
    )
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
  let tool: QualifiedToolName | undefined;
  if (toolValue !== undefined) {
    if (isCanonicalToolName(toolValue)) {
      tool = toolValue;
    } else {
      try {
        tool = fromRestrictedToolName(toolValue);
      } catch {
        return invalidQuery(
          context,
          "tool must be a canonical dotted or reversible restricted tool name.",
        );
      }
    }
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
    ...(tool === undefined ? {} : { tool }),
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
      ...(options.fileStore === undefined
        ? {}
        : { fileStore: options.fileStore }),
      credentialProvider:
        options.devVault ?? createConfiguredCredentialProvider({ env }),
    });
  if (
    options.fileStore !== undefined &&
    engine.fileStore !== options.fileStore
  ) {
    throw new Error(
      "The executor engine and file route must use the same file store.",
    );
  }
  if (
    options.devVault !== undefined &&
    engine.credentialProvider !== options.devVault
  ) {
    throw new Error(
      "The executor engine and dev-vault route must use the same credential provider.",
    );
  }
  if (
    options.devVoiceSessions !== undefined &&
    options.devVault === undefined
  ) {
    throw new Error(
      "The development voice-session route requires the development vault.",
    );
  }
  const keyring =
    options.apiKeys === undefined
      ? parseApiKeyring(env.EYEBALL_API_KEYS)
      : materializeApiKeyring(options.apiKeys);
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
    const principal = token === undefined ? undefined : keyring.get(token);
    if (principal === undefined) {
      return requestFailure(
        context,
        new EyeballError({
          code: TOOL_ERROR_CODES.AUTH_MISSING,
          message: "A valid Eyeball API key is required.",
        }),
        401,
      );
    }
    context.set("projectId", principal.projectId);
    context.set("pinnedUserId", principal.userId);
    if (
      principal.userId !== undefined &&
      context.req.header(USER_ID_HEADER) !== undefined &&
      context.req.header(USER_ID_HEADER) !== principal.userId
    ) {
      return pinnedUserFailure(context);
    }
    await next();
  });

  app.post("/v1/files", async (context) => {
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }
    if (!isRecord(request)) {
      return invalidQuery(context, "File upload must be a JSON object.");
    }
    const unknownKey = Object.keys(request).find(
      (key) => key !== "name" && key !== "mimeType" && key !== "content",
    );
    if (unknownKey !== undefined) {
      return invalidQuery(context, `Unknown file upload field: ${unknownKey}.`);
    }
    if (typeof request.name !== "string") {
      return invalidQuery(context, "name must be a string.");
    }
    if (
      request.mimeType !== undefined &&
      typeof request.mimeType !== "string"
    ) {
      return invalidQuery(context, "mimeType must be a string.");
    }
    if (typeof request.content !== "string") {
      return invalidQuery(context, "content must be a base64 string.");
    }
    const content = decodeBase64(request.content);
    if (content === undefined) {
      return invalidQuery(context, "content must be canonical padded base64.");
    }
    try {
      const file = await engine.stageFile(context.get("projectId"), {
        name: request.name,
        mimeType: request.mimeType ?? "application/octet-stream",
        content,
      });
      return context.json(file, 201);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/files/:id", async (context) => {
    try {
      const file = await engine.getFile(
        context.get("projectId"),
        context.req.param("id"),
      );
      return context.json(file.meta);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.post("/v1/execute", async (context) => {
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }

    try {
      const bodyUserId =
        typeof request === "object" && request !== null && "userId" in request
          ? typeof request.userId === "string"
            ? request.userId
            : undefined
          : undefined;
      if (
        rejectsPinnedUser(
          context,
          bodyUserId,
          context.req.header(USER_ID_HEADER),
        )
      ) {
        return pinnedUserFailure(context);
      }
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
    app.get("/v1/connections", async (context) => {
      try {
        const connections = await devVault.listConnections(
          context.get("projectId"),
        );
        const pinned = context.get("pinnedUserId");
        return context.json({
          connections:
            pinned === undefined
              ? connections
              : connections.filter(
                  (connection) => connection.userId === pinned,
                ),
        });
      } catch (error) {
        return handleRouteError(context, error);
      }
    });

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
      if (
        rejectsPinnedUser(
          context,
          typeof record.userId === "string" ? record.userId : undefined,
          context.req.header(USER_ID_HEADER),
        )
      ) {
        return pinnedUserFailure(context);
      }
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

    app.delete("/v1/connections/:id", async (context) => {
      const connectionId = context.req.param("id");
      if (!isConnectionId(connectionId)) {
        return invalidQuery(
          context,
          "Connection ID must be a valid conn_* identifier.",
        );
      }
      try {
        const pinned = context.get("pinnedUserId");
        if (pinned !== undefined) {
          const connections = await devVault.listConnections(
            context.get("projectId"),
          );
          const selected = connections.find(
            (connection) => connection.connectionId === connectionId,
          );
          if (selected !== undefined && selected.userId !== pinned) {
            return pinnedUserFailure(context);
          }
        }
        const connection = await devVault.revokeConnection(
          context.get("projectId"),
          connectionId,
        );
        return context.json({
          connectionId: connection.connectionId,
          status: connection.status,
        });
      } catch (error) {
        if (
          error instanceof EyeballError &&
          error.code === TOOL_ERROR_CODES.NOT_FOUND
        ) {
          return requestFailure(context, error, 404);
        }
        if (error instanceof EyeballError) {
          return requestFailure(context, error, 422);
        }
        return handleRouteError(context, error);
      }
    });

    const devVoiceSessions = options.devVoiceSessions;
    if (devVoiceSessions !== undefined) {
      app.post("/v1/dev/voice-sessions/:id/advance", async (context) => {
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
            "Advance request must be a JSON object.",
          );
        }
        const record = request as Readonly<Record<string, unknown>>;
        if (
          rejectsPinnedUser(
            context,
            typeof record.userId === "string" ? record.userId : undefined,
            context.req.header(USER_ID_HEADER),
          )
        ) {
          return pinnedUserFailure(context);
        }
        const unknownKey = Object.keys(record).find(
          (key) => key !== "userId" && key !== "milliseconds" && key !== "end",
        );
        if (unknownKey !== undefined) {
          return invalidQuery(
            context,
            `Unknown advance request field: ${unknownKey}.`,
          );
        }
        if (
          typeof record.userId !== "string" ||
          record.userId.trim().length === 0
        ) {
          return invalidQuery(context, "userId must be a non-empty string.");
        }
        const milliseconds = record.milliseconds ?? 1_000;
        if (
          !Number.isSafeInteger(milliseconds) ||
          Number(milliseconds) < 1 ||
          Number(milliseconds) > 60_000
        ) {
          return invalidQuery(
            context,
            "milliseconds must be an integer from 1 through 60000.",
          );
        }
        if (record.end !== undefined && typeof record.end !== "boolean") {
          return invalidQuery(context, "end must be a boolean.");
        }

        try {
          const result = await devVoiceSessions.advance({
            projectId: context.get("projectId"),
            userId: record.userId,
            sessionId: context.req.param("id"),
            milliseconds: Number(milliseconds),
            ...(record.end === true ? { end: true } : {}),
          });
          return context.json(result);
        } catch (error) {
          if (
            error instanceof EyeballError &&
            error.code === TOOL_ERROR_CODES.NOT_FOUND
          ) {
            return requestFailure(context, error, 404);
          }
          if (error instanceof EyeballError) {
            return requestFailure(context, error, 422);
          }
          return handleRouteError(context, error);
        }
      });
    }
  }

  app.get("/v1/executions", async (context) => {
    const query = parseListQuery(context);
    if (query instanceof Response) {
      return query;
    }
    const pinned = context.get("pinnedUserId");
    if (
      rejectsPinnedUser(
        context,
        query.userId,
        context.req.header(USER_ID_HEADER),
      )
    ) {
      return pinnedUserFailure(context);
    }
    if (pinned !== undefined) query.userId = pinned;
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
      if (rejectsPinnedUser(context, execution.userId)) {
        return pinnedUserFailure(context);
      }
      return context.json(execution);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  return app;
}
