import { randomUUID } from "node:crypto";
import {
  type ApiKeyringInput,
  CredentialProviderError,
  createErrorEnvelope,
  type ExecutionStatus,
  EyeballError,
  fromRestrictedToolName,
  isCanonicalToolName,
  isConnectionId,
  isExecutionId,
  isWebhookSubscriptionEventType,
  type JsonValue,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  VOICE_WORKER_EXECUTION_ID_HEADER,
  WEBHOOK_SUBSCRIPTION_EVENT_TYPES,
  type WebhookSubscriptionEventType,
} from "@eyeball/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type ApiKeyAuthenticationResult,
  type ApiKeyAuthenticator,
  createConfiguredApiKeyAuthenticator,
  StaticKeyringAuthenticator,
} from "./api-key-authenticator.js";
import { createConfiguredCredentialProvider } from "./credential-provider.js";
import type { DevVaultCredentialProvider } from "./dev-vault.js";
import type { DevVoiceSessionAdvancer } from "./dev-voice-sessions.js";
import {
  ExecutionEngine,
  ExecutionRequestError,
  type ListExecutionsQuery,
} from "./engine.js";
import {
  createRateLimitPolicies,
  type ExecutorRateLimitPolicies,
  InMemoryRateLimiter,
  type RateLimiter,
  type RateLimitPolicy,
  type RateLimitResult,
  rateLimitCapacity,
} from "./rate-limit.js";
import type { FileStore } from "./staged-files.js";
import type { HttpRequestClass, HttpRequestMethod } from "./telemetry/index.js";
import { TriggerRequestError } from "./triggers/service.js";
import { TriggerSubscriptionStoreError } from "./triggers/subscription-store.js";
import { WebhookDeliveryInputError } from "./webhooks/delivery-store.js";
import { WebhookEndpointInputError } from "./webhooks/endpoint-store.js";

const EXECUTION_STATUSES = new Set<ExecutionStatus>([
  "pending",
  "running",
  "succeeded",
  "failed",
]);

const MAX_TRIGGER_INGEST_BODY_BYTES = 1024 * 1024;
const FILE_UPLOAD_JSON_OVERHEAD_BYTES = 16 * 1024;

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
  apiKeyAuthenticator?: ApiKeyAuthenticator;
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  requestIdFactory?: () => string;
  rateLimiter?: RateLimiter;
  rateLimitPolicies?: ExecutorRateLimitPolicies;
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
  status: 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500,
): Response {
  return context.json(
    createErrorEnvelope(error, context.get("requestId")),
    status,
  );
}

function setRateLimitHeaders(
  context: ExecutorContext,
  policy: RateLimitPolicy,
  result: RateLimitResult,
): void {
  context.header("RateLimit-Limit", String(rateLimitCapacity(policy)));
  context.header("RateLimit-Remaining", String(result.remaining));
  context.header("RateLimit-Reset", String(Math.ceil(result.resetAt / 1_000)));
}

function retryAfterSeconds(result: RateLimitResult): number {
  return Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 1_000));
}

function telemetryRequestClass(method: string, path: string): HttpRequestClass {
  if (path === "/health") return "health";
  if (path.startsWith("/v1/ingest/")) return "ingest";
  if (method === "POST" && path === "/v1/execute") return "execute";
  return "standard";
}

function telemetryRequestMethod(method: string): HttpRequestMethod {
  switch (method.toUpperCase()) {
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "HEAD":
    case "OPTIONS":
      return method.toUpperCase() as HttpRequestMethod;
    default:
      return "OTHER";
  }
}

function rateLimitedFailure(
  context: ExecutorContext,
  policy: RateLimitPolicy,
  result: RateLimitResult,
  message: string,
): Response {
  setRateLimitHeaders(context, policy, result);
  const retryAfter = retryAfterSeconds(result);
  context.header("Retry-After", String(retryAfter));
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      message,
      retryable: true,
      retryAfter,
    }),
    429,
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

function projectAuthorityFailure(context: ExecutorContext): Response {
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      message:
        "Project-scoped webhook management requires an unpinned project API key.",
    }),
    403,
  );
}

function webhookNotFound(context: ExecutorContext): Response {
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.NOT_FOUND,
      message: "Webhook endpoint was not found.",
    }),
    404,
  );
}

function subscriptionNotFound(context: ExecutorContext): Response {
  return requestFailure(
    context,
    new EyeballError({
      code: TOOL_ERROR_CODES.NOT_FOUND,
      message: "Trigger subscription was not found.",
    }),
    404,
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
    if (error.httpStatus === 429) {
      if (error.rateLimit !== undefined) {
        context.header("RateLimit-Limit", String(error.rateLimit.limit));
        context.header(
          "RateLimit-Remaining",
          String(error.rateLimit.remaining),
        );
        context.header(
          "RateLimit-Reset",
          String(Math.ceil(error.rateLimit.resetAt / 1_000)),
        );
      }
      if (error.retryAfter !== undefined) {
        context.header("Retry-After", String(Math.ceil(error.retryAfter)));
      }
    }
    return requestFailure(context, error, error.httpStatus);
  }
  if (error instanceof TriggerRequestError) {
    return requestFailure(context, error, error.httpStatus);
  }
  if (
    error instanceof WebhookEndpointInputError ||
    error instanceof WebhookDeliveryInputError ||
    error instanceof TriggerSubscriptionStoreError
  ) {
    return invalidQuery(context, error.message);
  }
  if (error instanceof CredentialProviderError) {
    return requestFailure(
      context,
      new EyeballError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfter === undefined
          ? {}
          : { retryAfter: error.retryAfter }),
        cause: error,
      }),
      422,
    );
  }
  if (error instanceof EyeballError) {
    if (error.code === TOOL_ERROR_CODES.NOT_FOUND) {
      return requestFailure(context, error, 404);
    }
    if (
      error.code === TOOL_ERROR_CODES.INVALID_INPUT ||
      error.code === TOOL_ERROR_CODES.NOT_SUPPORTED ||
      error.code === TOOL_ERROR_CODES.AUTH_MISSING ||
      error.code === TOOL_ERROR_CODES.AUTH_EXPIRED ||
      error.code === TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE
    ) {
      return requestFailure(context, error, 422);
    }
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

function parseWebhookPageQuery(
  context: ExecutorContext,
): { cursor?: string; limit: number } | Response {
  const limitValue = context.req.query("limit");
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return invalidQuery(
      context,
      "limit must be an integer from 1 through 100.",
    );
  }
  const cursor = context.req.query("cursor");
  return { limit, ...(cursor === undefined ? {} : { cursor }) };
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
  if (
    options.apiKeys !== undefined &&
    options.apiKeyAuthenticator !== undefined
  ) {
    throw new Error(
      "Configure either apiKeys or apiKeyAuthenticator, not both.",
    );
  }
  const engine =
    options.engine ??
    new ExecutionEngine({
      env,
      ...(options.fileStore === undefined
        ? {}
        : { fileStore: options.fileStore }),
      credentialProvider:
        options.devVault ??
        createConfiguredCredentialProvider({
          env,
          ...(options.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.fetchImpl }),
        }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
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
  const apiKeyAuthenticator =
    options.apiKeyAuthenticator ??
    (options.apiKeys === undefined
      ? createConfiguredApiKeyAuthenticator({
          env,
          ...(options.fetchImpl === undefined
            ? {}
            : { fetchImpl: options.fetchImpl }),
        })
      : new StaticKeyringAuthenticator(options.apiKeys));
  const requestIdFactory =
    options.requestIdFactory ??
    (() => `req_${randomUUID().replaceAll("-", "")}`);
  const rateLimiter = options.rateLimiter ?? new InMemoryRateLimiter();
  const rateLimitPolicies =
    options.rateLimitPolicies ?? createRateLimitPolicies(env);
  const app = new Hono<{ Variables: ExecutorVariables }>();

  app.use("*", async (context, next) => {
    const startedAt = performance.now();
    let statusCode = 500;
    try {
      await next();
      statusCode = context.res.status;
    } finally {
      engine.telemetry.recordHttpRequest(
        telemetryRequestClass(context.req.method, context.req.path),
        telemetryRequestMethod(context.req.method),
        statusCode,
        Math.max(0, performance.now() - startedAt),
      );
    }
  });

  app.get("/health", (context) =>
    context.json({ status: "ok", service: "executor" }),
  );

  app.use("/v1/*", async (context, next) => {
    context.set("requestId", requestIdFactory());
    if (context.req.path.startsWith("/v1/ingest/")) {
      await next();
      return;
    }
    const token = bearerToken(context.req.header("Authorization"));
    if (token === undefined) {
      return requestFailure(
        context,
        new EyeballError({
          code: TOOL_ERROR_CODES.AUTH_MISSING,
          message: "A valid Eyeball API key is required.",
        }),
        401,
      );
    }
    let principal: ApiKeyAuthenticationResult;
    try {
      principal = await apiKeyAuthenticator.verify(token);
    } catch {
      return requestFailure(
        context,
        new EyeballError({
          code: TOOL_ERROR_CODES.AUTH_MISSING,
          message: "API key verification is temporarily unavailable.",
          retryable: true,
        }),
        401,
      );
    }
    if (!principal.valid) {
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

  app.use("/v1/*", async (context, next) => {
    if (context.req.path.startsWith("/v1/ingest/")) {
      await next();
      return;
    }
    const projectId = context.get("projectId");
    const executeRequest =
      context.req.method === "POST" && context.req.path === "/v1/execute";
    const requestPolicy = executeRequest
      ? rateLimitPolicies.execute
      : rateLimitPolicies.standard;
    const requestClass = executeRequest ? "execute" : "standard";
    const requestLimit = await rateLimiter.check(
      `project:${projectId}:requests:${requestClass}`,
      requestPolicy,
    );
    setRateLimitHeaders(context, requestPolicy, requestLimit);
    if (!requestLimit.allowed) {
      const bucket = executeRequest ? "request_execute" : "request_standard";
      engine.telemetry.recordRateLimitRejection(bucket);
      engine.telemetry.logger.warn("rate_limit.rejected", {
        projectId,
        bucket,
      });
      return rateLimitedFailure(
        context,
        requestPolicy,
        requestLimit,
        executeRequest
          ? "Execution request rate limit exceeded."
          : "Authenticated project request rate limit exceeded.",
      );
    }

    const dailyQuota = rateLimitPolicies.dailyExecutionQuota;
    if (executeRequest && dailyQuota !== undefined) {
      const quota = await rateLimiter.check(
        `project:${projectId}:quota:daily-executions`,
        dailyQuota,
      );
      if (!quota.allowed) {
        engine.telemetry.recordRateLimitRejection("daily_execution_quota");
        engine.telemetry.logger.warn("rate_limit.rejected", {
          projectId,
          bucket: "daily_execution_quota",
        });
        return rateLimitedFailure(
          context,
          dailyQuota,
          quota,
          "Daily project execution quota exceeded.",
        );
      }
    }
    await next();
  });

  app.post("/v1/webhooks", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }
    if (!isRecord(request)) {
      return invalidQuery(context, "Webhook endpoint must be a JSON object.");
    }
    const unknownKey = Object.keys(request).find(
      (key) => key !== "url" && key !== "events" && key !== "active",
    );
    if (unknownKey !== undefined) {
      return invalidQuery(
        context,
        `Unknown webhook endpoint field: ${unknownKey}.`,
      );
    }
    if (typeof request.url !== "string" || request.url.trim().length === 0) {
      return invalidQuery(context, "url must be a non-empty string.");
    }
    let url: URL;
    try {
      url = new URL(request.url.trim());
    } catch {
      return invalidQuery(context, "url must be an absolute HTTPS URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      return invalidQuery(
        context,
        "url must be an HTTPS URL without credentials or a fragment.",
      );
    }
    if (
      !Array.isArray(request.events) ||
      request.events.length === 0 ||
      request.events.some(
        (event) =>
          typeof event !== "string" || !isWebhookSubscriptionEventType(event),
      )
    ) {
      return invalidQuery(
        context,
        `events must contain one or more supported values: ${WEBHOOK_SUBSCRIPTION_EVENT_TYPES.join(
          ", ",
        )}.`,
      );
    }
    const events = request.events as WebhookSubscriptionEventType[];
    if (new Set(events).size !== events.length) {
      return invalidQuery(context, "events must not contain duplicates.");
    }
    if (request.active !== undefined && typeof request.active !== "boolean") {
      return invalidQuery(context, "active must be a boolean.");
    }

    try {
      const endpoint = await engine.webhookDeliverer.endpointStore.create(
        context.get("projectId"),
        {
          url: request.url.trim(),
          events,
          active: request.active ?? true,
          createdAt: new Date().toISOString(),
        },
      );
      return context.json(endpoint, 201);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/webhooks", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    const query = parseWebhookPageQuery(context);
    if (query instanceof Response) return query;
    try {
      const page = await engine.webhookDeliverer.endpointStore.list(
        context.get("projectId"),
        query,
      );
      return context.json(page);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.patch("/v1/webhooks/:id", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }
    if (!isRecord(request)) {
      return invalidQuery(context, "Webhook update must be a JSON object.");
    }
    const unknownKey = Object.keys(request).find(
      (key) => key !== "url" && key !== "events" && key !== "active",
    );
    if (unknownKey !== undefined) {
      return invalidQuery(
        context,
        `Unknown webhook update field: ${unknownKey}.`,
      );
    }
    if (
      request.url === undefined &&
      request.events === undefined &&
      request.active === undefined
    ) {
      return invalidQuery(
        context,
        "Webhook update must change url, events, or active.",
      );
    }
    if (request.url !== undefined) {
      if (typeof request.url !== "string" || request.url.trim().length === 0) {
        return invalidQuery(context, "url must be a non-empty string.");
      }
      let url: URL;
      try {
        url = new URL(request.url.trim());
      } catch {
        return invalidQuery(context, "url must be an absolute HTTPS URL.");
      }
      if (
        url.protocol !== "https:" ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.hash.length > 0
      ) {
        return invalidQuery(
          context,
          "url must be an HTTPS URL without credentials or a fragment.",
        );
      }
    }
    let events: WebhookSubscriptionEventType[] | undefined;
    if (request.events !== undefined) {
      if (
        !Array.isArray(request.events) ||
        request.events.length === 0 ||
        request.events.some(
          (event) =>
            typeof event !== "string" || !isWebhookSubscriptionEventType(event),
        )
      ) {
        return invalidQuery(
          context,
          `events must contain one or more supported values: ${WEBHOOK_SUBSCRIPTION_EVENT_TYPES.join(
            ", ",
          )}.`,
        );
      }
      events = request.events as WebhookSubscriptionEventType[];
      if (new Set(events).size !== events.length) {
        return invalidQuery(context, "events must not contain duplicates.");
      }
    }
    if (request.active !== undefined && typeof request.active !== "boolean") {
      return invalidQuery(context, "active must be a boolean.");
    }

    try {
      const endpoint = await engine.webhookDeliverer.endpointStore.update(
        context.get("projectId"),
        context.req.param("id"),
        {
          ...(request.url === undefined ? {} : { url: request.url.trim() }),
          ...(events === undefined ? {} : { events }),
          ...(request.active === undefined ? {} : { active: request.active }),
          updatedAt: new Date().toISOString(),
        },
      );
      return endpoint === undefined
        ? webhookNotFound(context)
        : context.json(endpoint);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.post("/v1/webhooks/:id/rotate-secret", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    try {
      const rotated = await engine.webhookDeliverer.endpointStore.rotateSecret(
        context.get("projectId"),
        context.req.param("id"),
        new Date().toISOString(),
      );
      return rotated === undefined
        ? webhookNotFound(context)
        : context.json(rotated);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/webhooks/:id/deliveries", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    const query = parseWebhookPageQuery(context);
    if (query instanceof Response) return query;
    try {
      const endpoint = await engine.webhookDeliverer.endpointStore.get(
        context.get("projectId"),
        context.req.param("id"),
      );
      if (endpoint === undefined) return webhookNotFound(context);
      const page = await engine.webhookDeliverer.deliveryStore.list(
        context.get("projectId"),
        endpoint.endpointId,
        query,
      );
      return context.json(page);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/webhooks/:id", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    try {
      const endpoint = await engine.webhookDeliverer.endpointStore.get(
        context.get("projectId"),
        context.req.param("id"),
      );
      return endpoint === undefined
        ? webhookNotFound(context)
        : context.json(endpoint);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.delete("/v1/webhooks/:id", async (context) => {
    if (context.get("pinnedUserId") !== undefined) {
      return projectAuthorityFailure(context);
    }
    try {
      const deleted = await engine.webhookDeliverer.endpointStore.delete(
        context.get("projectId"),
        context.req.param("id"),
      );
      return deleted ? context.body(null, 204) : webhookNotFound(context);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.post("/v1/subscriptions", async (context) => {
    let request: unknown;
    try {
      request = await context.req.json();
    } catch {
      return invalidQuery(context, "Request body must be valid JSON.");
    }
    if (!isRecord(request)) {
      return invalidQuery(
        context,
        "Trigger subscription must be a JSON object.",
      );
    }
    const unknownKey = Object.keys(request).find(
      (key) =>
        key !== "trigger" &&
        key !== "userId" &&
        key !== "connectionId" &&
        key !== "webhookEndpointIds" &&
        key !== "filters" &&
        key !== "pollIntervalSeconds",
    );
    if (unknownKey !== undefined) {
      return invalidQuery(
        context,
        `Unknown trigger subscription field: ${unknownKey}.`,
      );
    }
    if (typeof request.trigger !== "string") {
      return invalidQuery(context, "trigger must be a canonical trigger name.");
    }
    if (
      request.userId !== undefined &&
      (typeof request.userId !== "string" || request.userId.trim().length === 0)
    ) {
      return invalidQuery(context, "userId must be a non-empty string.");
    }
    const headerUserId = context.req.header(USER_ID_HEADER);
    if (headerUserId !== undefined && headerUserId.trim().length === 0) {
      return invalidQuery(context, `${USER_ID_HEADER} must not be empty.`);
    }
    if (
      typeof request.userId === "string" &&
      headerUserId !== undefined &&
      request.userId !== headerUserId
    ) {
      return invalidQuery(
        context,
        "userId conflicts with the X-Eyeball-User-Id header.",
      );
    }
    if (
      rejectsPinnedUser(
        context,
        typeof request.userId === "string" ? request.userId : undefined,
        headerUserId,
      )
    ) {
      return pinnedUserFailure(context);
    }
    const userId =
      context.get("pinnedUserId") ??
      (typeof request.userId === "string" ? request.userId : headerUserId);
    if (userId === undefined) {
      return invalidQuery(context, "userId or X-Eyeball-User-Id is required.");
    }
    if (
      request.connectionId !== undefined &&
      typeof request.connectionId !== "string"
    ) {
      return invalidQuery(context, "connectionId must be a string.");
    }
    if (
      !Array.isArray(request.webhookEndpointIds) ||
      request.webhookEndpointIds.some((value) => typeof value !== "string")
    ) {
      return invalidQuery(
        context,
        "webhookEndpointIds must be an array of endpoint ID strings.",
      );
    }
    if (request.filters !== undefined && !isRecord(request.filters)) {
      return invalidQuery(context, "filters must be a JSON object.");
    }
    if (
      request.pollIntervalSeconds !== undefined &&
      typeof request.pollIntervalSeconds !== "number"
    ) {
      return invalidQuery(context, "pollIntervalSeconds must be a number.");
    }

    try {
      const created = await engine.triggerService.create({
        projectId: context.get("projectId"),
        userId,
        trigger: request.trigger,
        ...(request.connectionId === undefined
          ? {}
          : { connectionId: request.connectionId as string }),
        webhookEndpointIds: request.webhookEndpointIds as string[],
        ...(request.filters === undefined
          ? {}
          : {
              filters: request.filters as Readonly<Record<string, JsonValue>>,
            }),
        ...(request.pollIntervalSeconds === undefined
          ? {}
          : { pollIntervalSeconds: request.pollIntervalSeconds }),
        ingestBaseUrl: new URL(context.req.url).origin,
      });
      return context.json(created, 201);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/subscriptions", async (context) => {
    const queryUserId = context.req.query("userId");
    const headerUserId = context.req.header(USER_ID_HEADER);
    if (queryUserId !== undefined && queryUserId.trim().length === 0) {
      return invalidQuery(context, "userId must not be empty.");
    }
    if (headerUserId !== undefined && headerUserId.trim().length === 0) {
      return invalidQuery(context, `${USER_ID_HEADER} must not be empty.`);
    }
    if (
      queryUserId !== undefined &&
      headerUserId !== undefined &&
      queryUserId !== headerUserId
    ) {
      return invalidQuery(
        context,
        "userId conflicts with the X-Eyeball-User-Id header.",
      );
    }
    if (rejectsPinnedUser(context, queryUserId, headerUserId)) {
      return pinnedUserFailure(context);
    }
    const limitValue = context.req.query("limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    ) {
      return invalidQuery(
        context,
        "limit must be an integer from 1 through 100.",
      );
    }
    const userId = context.get("pinnedUserId") ?? queryUserId ?? headerUserId;
    const cursor = context.req.query("cursor");
    try {
      const page = await engine.triggerService.list(context.get("projectId"), {
        ...(userId === undefined ? {} : { userId }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      });
      return context.json(page);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.get("/v1/subscriptions/:id", async (context) => {
    try {
      const subscription = await engine.triggerService.get(
        context.get("projectId"),
        context.req.param("id"),
      );
      if (subscription === undefined) return subscriptionNotFound(context);
      if (rejectsPinnedUser(context, subscription.userId)) {
        return pinnedUserFailure(context);
      }
      return context.json(subscription);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.delete("/v1/subscriptions/:id", async (context) => {
    try {
      const subscription = await engine.triggerService.get(
        context.get("projectId"),
        context.req.param("id"),
      );
      if (subscription === undefined) return subscriptionNotFound(context);
      if (rejectsPinnedUser(context, subscription.userId)) {
        return pinnedUserFailure(context);
      }
      return (await engine.triggerService.delete(
        context.get("projectId"),
        subscription.subscriptionId,
      ))
        ? context.body(null, 204)
        : subscriptionNotFound(context);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.post("/v1/subscriptions/:id/rotate-secret", async (context) => {
    try {
      const subscription = await engine.triggerService.get(
        context.get("projectId"),
        context.req.param("id"),
      );
      if (subscription === undefined) return subscriptionNotFound(context);
      if (rejectsPinnedUser(context, subscription.userId)) {
        return pinnedUserFailure(context);
      }
      const rotated = await engine.triggerService.rotateIngestSecret(
        context.get("projectId"),
        subscription.subscriptionId,
        new URL(context.req.url).origin,
      );
      return rotated === undefined
        ? subscriptionNotFound(context)
        : context.json(rotated);
    } catch (error) {
      return handleRouteError(context, error);
    }
  });

  app.post(
    "/v1/ingest/:subscriptionId/:secret",
    bodyLimit({
      maxSize: MAX_TRIGGER_INGEST_BODY_BYTES,
      onError: (context) =>
        requestFailure(
          context as ExecutorContext,
          new EyeballError({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message: "Trigger ingest payload exceeds the 1 MiB limit.",
            retryable: false,
          }),
          413,
        ),
    }),
    async (context) => {
      try {
        const result = await engine.triggerService.ingest(
          context.req.param("subscriptionId"),
          context.req.param("secret"),
          await context.req.text(),
          context.req.raw.headers,
        );
        return result.kind === "challenge"
          ? context.json({ challenge: result.challenge })
          : context.json(result, 202);
      } catch (error) {
        return handleRouteError(context, error);
      }
    },
  );

  app.post(
    "/v1/files",
    bodyLimit({
      maxSize:
        Math.ceil(engine.maxFileSizeBytes / 3) * 4 +
        FILE_UPLOAD_JSON_OVERHEAD_BYTES,
      onError: (context) =>
        requestFailure(
          context as ExecutorContext,
          new EyeballError({
            code: TOOL_ERROR_CODES.INVALID_INPUT,
            message:
              "File upload payload exceeds the configured staging limit.",
            retryable: false,
          }),
          413,
        ),
    }),
    async (context) => {
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
        return invalidQuery(
          context,
          `Unknown file upload field: ${unknownKey}.`,
        );
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
        return invalidQuery(
          context,
          "content must be canonical padded base64.",
        );
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
    },
  );

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
      const reservedExecutionId = context.req.header(
        VOICE_WORKER_EXECUTION_ID_HEADER,
      );
      if (
        reservedExecutionId !== undefined &&
        !isExecutionId(reservedExecutionId)
      ) {
        return invalidQuery(
          context,
          `${VOICE_WORKER_EXECUTION_ID_HEADER} must be a canonical execution ID.`,
        );
      }
      if (
        reservedExecutionId !== undefined &&
        context.get("pinnedUserId") === undefined
      ) {
        return context.json(
          createErrorEnvelope(
            {
              code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
              message: `${VOICE_WORKER_EXECUTION_ID_HEADER} requires a user-pinned API key.`,
              retryable: false,
            },
            context.get("requestId"),
          ),
          403,
        );
      }
      if (reservedExecutionId !== undefined && idempotencyKey === undefined) {
        return invalidQuery(
          context,
          `${VOICE_WORKER_EXECUTION_ID_HEADER} requires Idempotency-Key.`,
        );
      }
      if (
        reservedExecutionId !== undefined &&
        (!isRecord(request) || request.mode !== "sync")
      ) {
        return invalidQuery(
          context,
          `${VOICE_WORKER_EXECUTION_ID_HEADER} is restricted to synchronous child executions.`,
        );
      }
      const outcome = await engine.execute({
        projectId: context.get("projectId"),
        request,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(reservedExecutionId === undefined
          ? {}
          : { executionId: reservedExecutionId }),
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
