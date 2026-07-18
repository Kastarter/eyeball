import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type CatalogVersion,
  type CreatedTriggerSubscription,
  type CredentialProvider,
  CredentialProviderError,
  createTriggerSubscriptionId,
  EyeballError,
  isCanonicalToolName,
  isConnectionId,
  isTriggerSubscriptionId,
  type JsonValue,
  type ProviderManifest,
  type ResolvedCredential,
  TOOL_ERROR_CODES,
  type TriggerDefinition,
  type TriggerEventData,
  type TriggerSubscription,
  type TriggerSubscriptionId,
  type TriggerSubscriptionPage,
  validateTriggerPayload,
} from "@eyeball/core";
import type {
  Clock,
  ExecutorLogger,
  FetchImplementation,
} from "../adapters/index.js";
import { noopLogger, systemClock } from "../adapters/index.js";
import {
  createExecutorTelemetryRuntime,
  type ExecutorTelemetryRuntime,
  markSpanError,
  markSpanOk,
} from "../telemetry/index.js";
import type { WebhookDeliverer } from "../webhooks/deliverer.js";
import { defaultTriggerAdapters, TriggerAdapterRegistry } from "./adapters.js";
import {
  InMemoryTriggerStateStore,
  type TriggerState,
  type TriggerStateStore,
} from "./state-store.js";
import {
  InMemoryTriggerSubscriptionStore,
  type ListTriggerSubscriptionsInput,
  type StoredTriggerSubscription,
  type TriggerSubscriptionStore,
} from "./subscription-store.js";

const DEFAULT_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface RuntimeTriggerCatalog {
  readonly catalogVersion: CatalogVersion;
  getTrigger(name: string): TriggerDefinition | undefined;
  getManifest(toolkitSlug: string): ProviderManifest | undefined;
  getEffectiveTriggerScopes(
    name: string,
  ): { required: readonly string[]; optional: readonly string[] } | undefined;
}

export interface TriggerServiceOptions {
  catalog: RuntimeTriggerCatalog;
  credentialProvider: CredentialProvider;
  webhookDeliverer: WebhookDeliverer;
  subscriptionStore?: TriggerSubscriptionStore;
  stateStore?: TriggerStateStore;
  adapters?: TriggerAdapterRegistry;
  fetchImpl?: FetchImplementation;
  clock?: Clock;
  telemetry?: ExecutorTelemetryRuntime;
  /** @deprecated Pass telemetry from ExecutionEngine instead. */
  logger?: ExecutorLogger;
  env?: Readonly<Record<string, string | undefined>>;
  subscriptionIdFactory?: () => TriggerSubscriptionId;
  ingestSecretFactory?: () => string;
  dedupRetentionMs?: number;
}

export interface CreateTriggerSubscriptionCommand {
  projectId: string;
  userId: string;
  trigger: string;
  connectionId?: string;
  webhookEndpointIds: readonly string[];
  filters?: Readonly<Record<string, JsonValue>>;
  pollIntervalSeconds?: number;
  ingestBaseUrl: string;
}

export interface ListTriggerSubscriptionsQuery
  extends Omit<ListTriggerSubscriptionsInput, "limit"> {
  limit?: number;
}

export type TriggerIngestResult =
  | { kind: "challenge"; challenge: string }
  | { kind: "accepted"; accepted: number; duplicates: number };

export interface TriggerPollTickResult {
  polled: number;
  emitted: number;
  duplicates: number;
  failed: number;
}

export class TriggerRequestError extends EyeballError {
  readonly httpStatus: 404 | 409 | 422;

  constructor(
    httpStatus: 404 | 409 | 422,
    options: ConstructorParameters<typeof EyeballError>[0],
  ) {
    super(options);
    this.name = "TriggerRequestError";
    this.httpStatus = httpStatus;
  }
}

function invalidRequest(message: string): never {
  throw new TriggerRequestError(422, {
    code: TOOL_ERROR_CODES.INVALID_INPUT,
    message,
  });
}

function notFound(message = "Trigger subscription was not found."): never {
  throw new TriggerRequestError(404, {
    code: TOOL_ERROR_CODES.NOT_FOUND,
    message,
  });
}

function notSupported(message: string): never {
  throw new TriggerRequestError(422, {
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message,
  });
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidRequest(`${field} must be a positive safe integer.`);
  }
  return value;
}

function resolveBaseUrl(
  manifest: ProviderManifest,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const overrideName = manifest.endpoint.baseUrlOverrideEnv;
  const override =
    overrideName === undefined ? undefined : env[overrideName]?.trim();
  const candidate =
    override === undefined || override.length === 0
      ? manifest.endpoint.baseUrl
      : override;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return invalidRequest(
      `The configured ${manifest.toolkit.slug} base URL is invalid.`,
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return invalidRequest(
      `The configured ${manifest.toolkit.slug} base URL is invalid.`,
    );
  }
  return url.toString();
}

function validateCredential(
  credential: ResolvedCredential,
  subscription: Pick<
    TriggerSubscription,
    "connectionId" | "trigger" | "userId"
  >,
  manifest: ProviderManifest,
  requiredScopes: readonly string[],
  now: Date,
): void {
  if (credential.type !== manifest.auth.class) {
    throw new CredentialProviderError({
      code: "auth_missing",
      message: `No usable ${manifest.toolkit.slug} credential matches the required auth class.`,
      retryable: false,
    });
  }
  if (
    subscription.connectionId !== undefined &&
    credential.connectionId !== subscription.connectionId
  ) {
    throw new CredentialProviderError({
      code: "auth_missing",
      message:
        "No usable connection exists for this project, user, and trigger toolkit.",
      retryable: false,
    });
  }
  if (
    credential.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(credential.expiresAt)) ||
      Date.parse(credential.expiresAt) <= now.valueOf())
  ) {
    throw new CredentialProviderError({
      code: "auth_expired",
      message: `The selected ${manifest.toolkit.slug} credential is expired.`,
      retryable: false,
    });
  }
  if (
    requiredScopes.some((scope) => credential.scopes?.includes(scope) !== true)
  ) {
    throw new CredentialProviderError({
      code: "auth_insufficient_scope",
      message: `The selected ${manifest.toolkit.slug} credential lacks a required trigger scope.`,
      retryable: false,
    });
  }
}

function credentialFailureKind(error: unknown): string {
  if (
    error instanceof CredentialProviderError ||
    error instanceof EyeballError
  ) {
    return error.code;
  }
  return "unexpected_error";
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(secretHash(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function ingestUrl(
  baseUrl: string,
  subscriptionId: TriggerSubscriptionId,
  secret: string,
): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return invalidRequest("ingestBaseUrl must be an absolute HTTP(S) URL.");
  }
  if (
    (base.protocol !== "https:" && base.protocol !== "http:") ||
    base.username.length > 0 ||
    base.password.length > 0
  ) {
    return invalidRequest("ingestBaseUrl must be an absolute HTTP(S) URL.");
  }
  return new URL(
    `/v1/ingest/${encodeURIComponent(subscriptionId)}/${encodeURIComponent(secret)}`,
    base,
  ).toString();
}

function validateFilters(
  trigger: TriggerDefinition,
  filters: Readonly<Record<string, JsonValue>> | undefined,
): void {
  if (filters === undefined) return;
  const allowed =
    trigger.capability === "email"
      ? new Set(["from", "to", "subjectContains"])
      : trigger.capability === "messaging_chat"
        ? new Set(["conversationId", "from"])
        : new Set<string>();
  const unknown = Object.keys(filters).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    invalidRequest(`Unknown ${trigger.name} filter: ${unknown}.`);
  }
  const invalid = Object.entries(filters).find(
    ([, value]) => typeof value !== "string" || value.trim().length === 0,
  );
  if (invalid !== undefined) {
    invalidRequest(
      `${trigger.name} filter ${invalid[0]} must be a non-empty string.`,
    );
  }
}

export class TriggerService {
  readonly catalog: RuntimeTriggerCatalog;
  readonly credentialProvider: CredentialProvider;
  readonly webhookDeliverer: WebhookDeliverer;
  readonly subscriptionStore: TriggerSubscriptionStore;
  readonly stateStore: TriggerStateStore;
  readonly adapters: TriggerAdapterRegistry;
  readonly #fetchImpl: FetchImplementation;
  readonly #clock: Clock;
  readonly #logger: ExecutorLogger;
  readonly #telemetry: ExecutorTelemetryRuntime;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #subscriptionIdFactory: () => TriggerSubscriptionId;
  readonly #ingestSecretFactory: () => string;
  readonly #dedupRetentionMs: number;
  readonly #polling = new Set<TriggerSubscriptionId>();

  constructor(options: TriggerServiceOptions) {
    this.catalog = options.catalog;
    this.credentialProvider = options.credentialProvider;
    this.webhookDeliverer = options.webhookDeliverer;
    this.subscriptionStore =
      options.subscriptionStore ?? new InMemoryTriggerSubscriptionStore();
    this.stateStore = options.stateStore ?? new InMemoryTriggerStateStore();
    this.adapters =
      options.adapters ?? new TriggerAdapterRegistry(defaultTriggerAdapters);
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#clock = options.clock ?? systemClock;
    this.#env = options.env ?? process.env;
    this.#telemetry =
      options.telemetry ??
      createExecutorTelemetryRuntime(
        options.logger === undefined ? {} : { logger: options.logger },
        this.#env,
      );
    this.#logger = this.#telemetry.logger;
    this.#subscriptionIdFactory =
      options.subscriptionIdFactory ?? createTriggerSubscriptionId;
    this.#ingestSecretFactory =
      options.ingestSecretFactory ??
      (() => `trgsec_${randomBytes(32).toString("base64url")}`);
    this.#dedupRetentionMs = positiveSafeInteger(
      options.dedupRetentionMs ?? DEFAULT_DEDUP_RETENTION_MS,
      "dedupRetentionMs",
    );
  }

  async create(
    command: CreateTriggerSubscriptionCommand,
  ): Promise<CreatedTriggerSubscription> {
    if (command.projectId.trim().length === 0) {
      return invalidRequest("Authenticated project ID must not be empty.");
    }
    if (command.userId.trim().length === 0) {
      return invalidRequest("userId must be a non-empty string.");
    }
    if (!isCanonicalToolName(command.trigger)) {
      return invalidRequest("trigger must be a canonical dotted trigger name.");
    }
    const trigger = this.catalog.getTrigger(command.trigger);
    if (trigger === undefined) {
      return notSupported(`Trigger ${command.trigger} is not supported.`);
    }
    const manifest = this.catalog.getManifest(trigger.toolkit);
    const scopes = this.catalog.getEffectiveTriggerScopes(trigger.name);
    if (manifest === undefined || scopes === undefined) {
      return notSupported(`Trigger ${command.trigger} is not supported.`);
    }
    if (
      command.connectionId !== undefined &&
      !isConnectionId(command.connectionId)
    ) {
      return invalidRequest("connectionId must be a valid conn_* identifier.");
    }
    if (
      command.webhookEndpointIds.length === 0 ||
      new Set(command.webhookEndpointIds).size !==
        command.webhookEndpointIds.length ||
      command.webhookEndpointIds.some((endpointId) => endpointId.length === 0)
    ) {
      return invalidRequest(
        "webhookEndpointIds must contain one or more distinct endpoint IDs.",
      );
    }
    for (const endpointId of command.webhookEndpointIds) {
      const endpoint = await this.webhookDeliverer.endpointStore.get(
        command.projectId,
        endpointId,
      );
      if (endpoint === undefined) {
        return invalidRequest(`Webhook endpoint ${endpointId} was not found.`);
      }
      if (
        !endpoint.events.includes("trigger.*") &&
        !endpoint.events.includes(`trigger.${trigger.name}`)
      ) {
        return invalidRequest(
          `Webhook endpoint ${endpointId} is not subscribed to trigger.${trigger.name}.`,
        );
      }
    }
    validateFilters(trigger, command.filters);
    let pollIntervalSeconds: number | undefined;
    if (trigger.annotations.deliveryMode === "polling") {
      pollIntervalSeconds =
        command.pollIntervalSeconds ??
        trigger.annotations.defaultIntervalSeconds;
      if (
        !Number.isSafeInteger(pollIntervalSeconds) ||
        pollIntervalSeconds < trigger.annotations.minimumIntervalSeconds
      ) {
        return invalidRequest(
          `pollIntervalSeconds must be an integer of at least ${trigger.annotations.minimumIntervalSeconds}.`,
        );
      }
    } else if (command.pollIntervalSeconds !== undefined) {
      return invalidRequest(
        "pollIntervalSeconds is available only for polling triggers.",
      );
    }

    const credential = await this.credentialProvider.resolve({
      projectId: command.projectId,
      userId: command.userId,
      toolkitSlug: trigger.toolkit,
      ...(command.connectionId === undefined
        ? {}
        : { connectionId: command.connectionId }),
    });
    validateCredential(
      credential,
      {
        trigger: trigger.name,
        userId: command.userId,
        ...(command.connectionId === undefined
          ? {}
          : { connectionId: command.connectionId }),
      },
      manifest,
      scopes.required,
      this.#now(),
    );

    const subscriptionId = this.#subscriptionIdFactory();
    if (!isTriggerSubscriptionId(subscriptionId)) {
      throw new Error(
        "Trigger subscription ID factory returned an invalid trgsub_* identifier.",
      );
    }
    const createdAt = this.#now().toISOString();
    const secret =
      trigger.annotations.deliveryMode === "push"
        ? this.#ingestSecretFactory()
        : undefined;
    if (secret !== undefined && secret.length < 32) {
      throw new Error("Trigger ingest secret factory returned a short secret.");
    }
    const stored: StoredTriggerSubscription = {
      subscriptionId,
      projectId: command.projectId,
      userId: command.userId,
      trigger: trigger.name,
      ...(command.connectionId === undefined
        ? {}
        : { connectionId: command.connectionId }),
      webhookEndpointIds: [...command.webhookEndpointIds],
      ...(command.filters === undefined
        ? {}
        : { filters: structuredClone(command.filters) }),
      ...(pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds }),
      status: "active",
      createdAt,
      updatedAt: createdAt,
      ...(secret === undefined ? {} : { ingestSecretHash: secretHash(secret) }),
    };
    const created = await this.subscriptionStore.create(stored);
    try {
      if (pollIntervalSeconds !== undefined) {
        await this.stateStore.put({
          subscriptionId,
          nextPollAt: new Date(
            this.#now().valueOf() + pollIntervalSeconds * 1_000,
          ).toISOString(),
          updatedAt: createdAt,
        });
      }
    } catch (error) {
      await this.subscriptionStore.delete(command.projectId, subscriptionId);
      throw error;
    }
    return {
      ...created,
      ...(secret === undefined
        ? {}
        : {
            ingestUrl: ingestUrl(command.ingestBaseUrl, subscriptionId, secret),
          }),
    };
  }

  list(
    projectId: string,
    query: ListTriggerSubscriptionsQuery = {},
  ): Promise<TriggerSubscriptionPage> {
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return invalidRequest("limit must be an integer from 1 through 100.");
    }
    return this.subscriptionStore.list(projectId, {
      limit,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.userId === undefined ? {} : { userId: query.userId }),
    });
  }

  get(
    projectId: string,
    subscriptionId: string,
  ): Promise<TriggerSubscription | undefined> {
    return this.subscriptionStore.get(projectId, subscriptionId);
  }

  async delete(projectId: string, subscriptionId: string): Promise<boolean> {
    if (!isTriggerSubscriptionId(subscriptionId)) return false;
    const deleted = await this.subscriptionStore.delete(
      projectId,
      subscriptionId,
    );
    if (deleted) await this.stateStore.delete(subscriptionId);
    return deleted;
  }

  async ingest(
    subscriptionId: string,
    secret: string,
    rawBody: string,
    headers: Headers,
  ): Promise<TriggerIngestResult> {
    const ingestSpan = this.#telemetry.startSpan("eyeball.trigger.ingest");
    try {
      if (!isTriggerSubscriptionId(subscriptionId)) return notFound();
      const subscription =
        await this.subscriptionStore.getInternal(subscriptionId);
      if (
        subscription === undefined ||
        subscription.status !== "active" ||
        subscription.ingestSecretHash === undefined ||
        !secretMatches(secret, subscription.ingestSecretHash)
      ) {
        return notFound();
      }
      ingestSpan.span?.setAttribute(
        "eyeball.trigger.subscription.id",
        subscription.subscriptionId,
      );
      const resolved = await this.#resolveRuntime(subscription);
      ingestSpan.span?.setAttribute("eyeball.trigger", resolved.trigger.name);
      if (resolved.trigger.annotations.deliveryMode !== "push") {
        return notFound();
      }
      const adapter = this.adapters.get(resolved.trigger.toolkit);
      if (adapter?.ingestPush === undefined) {
        return notSupported(
          `Trigger ${resolved.trigger.name} has no push adapter.`,
        );
      }
      const result = await adapter.ingestPush(
        this.#adapterContext(subscription, resolved),
        rawBody,
        headers,
      );
      if (result.kind === "challenge") {
        this.#logger.info("trigger.ingest", {
          subscriptionId,
          trigger: resolved.trigger.name,
          status: "challenge",
          deduped: false,
        });
        markSpanOk(ingestSpan.span);
        return result;
      }
      let accepted = 0;
      let duplicates = 0;
      for (const event of result.events) {
        if (await this.#emit(subscription, resolved.trigger, event)) {
          accepted += 1;
        } else {
          duplicates += 1;
        }
      }
      ingestSpan.span?.setAttribute("eyeball.trigger.accepted", accepted);
      ingestSpan.span?.setAttribute("eyeball.trigger.duplicates", duplicates);
      this.#logger.info("trigger.ingest", {
        subscriptionId,
        trigger: resolved.trigger.name,
        status: "accepted",
        accepted,
        duplicates,
        deduped: duplicates > 0,
      });
      markSpanOk(ingestSpan.span);
      return { kind: "accepted", accepted, duplicates };
    } catch (error) {
      markSpanError(ingestSpan.span, error);
      throw error;
    } finally {
      ingestSpan.span?.end();
    }
  }

  async runDue(): Promise<TriggerPollTickResult> {
    const result: TriggerPollTickResult = {
      polled: 0,
      emitted: 0,
      duplicates: 0,
      failed: 0,
    };
    const now = this.#now();
    for (const subscription of await this.subscriptionStore.listActive()) {
      const trigger = this.catalog.getTrigger(subscription.trigger);
      if (trigger?.annotations.deliveryMode !== "polling") continue;
      const state = await this.stateStore.get(subscription.subscriptionId);
      const nextPollAt =
        state?.nextPollAt === undefined ? 0 : Date.parse(state.nextPollAt);
      if (!Number.isFinite(nextPollAt) || nextPollAt > now.valueOf()) continue;
      if (this.#polling.has(subscription.subscriptionId)) continue;
      this.#polling.add(subscription.subscriptionId);
      result.polled += 1;
      const pollSpan = this.#telemetry.startSpan("eyeball.trigger.poll", {
        "eyeball.trigger.subscription.id": subscription.subscriptionId,
        "eyeball.trigger": subscription.trigger,
      });
      try {
        const counts = await this.#pollOne(subscription, trigger, state, now);
        result.emitted += counts.emitted;
        result.duplicates += counts.duplicates;
        pollSpan.span?.setAttribute("eyeball.trigger.emitted", counts.emitted);
        pollSpan.span?.setAttribute(
          "eyeball.trigger.duplicates",
          counts.duplicates,
        );
        this.#logger.info("trigger.poll", {
          subscriptionId: subscription.subscriptionId,
          trigger: subscription.trigger,
          status: "succeeded",
          emitted: counts.emitted,
          duplicates: counts.duplicates,
          deduped: counts.duplicates > 0,
        });
        markSpanOk(pollSpan.span);
      } catch (error) {
        result.failed += 1;
        markSpanError(pollSpan.span, error);
        this.#logger.warn("trigger.poll", {
          subscriptionId: subscription.subscriptionId,
          trigger: subscription.trigger,
          status: "failed",
          deduped: false,
          errorKind: error instanceof Error ? error.name : "unknown",
        });
        await this.#scheduleNext(subscription, state, now);
      } finally {
        pollSpan.span?.end();
        this.#polling.delete(subscription.subscriptionId);
      }
    }
    return result;
  }

  async #pollOne(
    subscription: StoredTriggerSubscription,
    trigger: TriggerDefinition,
    state: TriggerState | undefined,
    now: Date,
  ): Promise<{ emitted: number; duplicates: number }> {
    const resolved = await this.#resolveRuntime(subscription);
    const adapter = this.adapters.get(trigger.toolkit);
    if (adapter?.poll === undefined) {
      return notSupported(`Trigger ${trigger.name} has no polling adapter.`);
    }
    const polled = await adapter.poll(
      this.#adapterContext(subscription, resolved),
      state?.cursor,
    );
    let emitted = 0;
    let duplicates = 0;
    for (const event of polled.events) {
      if (await this.#emit(subscription, trigger, event)) emitted += 1;
      else duplicates += 1;
    }
    await this.stateStore.put({
      subscriptionId: subscription.subscriptionId,
      ...(polled.cursor === undefined
        ? state?.cursor === undefined
          ? {}
          : { cursor: state.cursor }
        : { cursor: polled.cursor }),
      nextPollAt: this.#nextPollAt(subscription, now),
      updatedAt: this.#now().toISOString(),
    });
    return { emitted, duplicates };
  }

  async #scheduleNext(
    subscription: StoredTriggerSubscription,
    state: TriggerState | undefined,
    now: Date,
  ): Promise<void> {
    await this.stateStore.put({
      subscriptionId: subscription.subscriptionId,
      ...(state?.cursor === undefined ? {} : { cursor: state.cursor }),
      nextPollAt: this.#nextPollAt(subscription, now),
      updatedAt: this.#now().toISOString(),
    });
  }

  #nextPollAt(subscription: StoredTriggerSubscription, from: Date): string {
    const seconds = subscription.pollIntervalSeconds;
    if (seconds === undefined) {
      throw new Error(
        "Polling trigger subscription omitted pollIntervalSeconds.",
      );
    }
    return new Date(from.valueOf() + seconds * 1_000).toISOString();
  }

  async #emit(
    subscription: StoredTriggerSubscription,
    trigger: TriggerDefinition,
    event: {
      providerEventId: string;
      occurredAt: string;
      payload: Readonly<Record<string, JsonValue>>;
    },
  ): Promise<boolean> {
    if (event.providerEventId.length === 0) {
      return invalidRequest("Provider event ID must not be empty.");
    }
    if (!Number.isFinite(Date.parse(event.occurredAt))) {
      return invalidRequest("Provider event occurredAt must be a timestamp.");
    }
    const validation = validateTriggerPayload(trigger, event.payload);
    if (!validation.ok) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.PROVIDER_ERROR,
        message: `Normalized payload for ${trigger.name} violated its canonical schema.`,
        providerDetail: {
          toolkit: trigger.toolkit,
          detail: {
            issue: validation.errors[0]?.message ?? "unknown",
          },
        },
      });
    }
    const now = this.#now();
    const claimed = await this.stateStore.claimProviderEvent(
      subscription.subscriptionId,
      event.providerEventId,
      now.toISOString(),
      new Date(now.valueOf() + this.#dedupRetentionMs).toISOString(),
    );
    this.#telemetry.recordTriggerEvent(trigger.name, !claimed);
    if (!claimed) return false;
    const data: TriggerEventData = {
      subscriptionId: subscription.subscriptionId,
      trigger: trigger.name,
      userId: subscription.userId,
      ...(subscription.connectionId === undefined
        ? {}
        : { connectionId: subscription.connectionId }),
      providerEventId: event.providerEventId,
      occurredAt: event.occurredAt,
      payload: validation.value,
    };
    this.webhookDeliverer.enqueueTriggerEvent({
      projectId: subscription.projectId,
      endpointIds: subscription.webhookEndpointIds,
      trigger: trigger.name,
      data,
      createdAt: now.toISOString(),
    });
    return true;
  }

  async #resolveRuntime(subscription: StoredTriggerSubscription): Promise<{
    trigger: TriggerDefinition;
    manifest: ProviderManifest;
    credential: ResolvedCredential;
    baseUrl: string;
  }> {
    const trigger = this.catalog.getTrigger(subscription.trigger);
    if (trigger === undefined) {
      return notSupported(`Trigger ${subscription.trigger} is not supported.`);
    }
    const manifest = this.catalog.getManifest(trigger.toolkit);
    const scopes = this.catalog.getEffectiveTriggerScopes(trigger.name);
    if (manifest === undefined || scopes === undefined) {
      return notSupported(`Trigger ${subscription.trigger} is not supported.`);
    }
    let credential: ResolvedCredential;
    try {
      credential = await this.credentialProvider.resolve({
        projectId: subscription.projectId,
        userId: subscription.userId,
        toolkitSlug: trigger.toolkit,
        ...(subscription.connectionId === undefined
          ? {}
          : { connectionId: subscription.connectionId }),
      });
      validateCredential(
        credential,
        subscription,
        manifest,
        scopes.required,
        this.#now(),
      );
    } catch (error) {
      this.#logger.warn("credential.resolution_failed", {
        subscriptionId: subscription.subscriptionId,
        trigger: subscription.trigger,
        projectId: subscription.projectId,
        kind: credentialFailureKind(error),
      });
      throw error;
    }
    return {
      trigger,
      manifest,
      credential,
      baseUrl: resolveBaseUrl(manifest, this.#env),
    };
  }

  #adapterContext(
    subscription: StoredTriggerSubscription,
    runtime: {
      trigger: TriggerDefinition;
      credential: ResolvedCredential;
      baseUrl: string;
    },
  ) {
    return {
      projectId: subscription.projectId,
      userId: subscription.userId,
      trigger: runtime.trigger,
      subscription,
      credential: runtime.credential,
      baseUrl: runtime.baseUrl,
      fetchImpl: this.#fetchImpl,
      clock: this.#clock,
      logger: this.#logger,
    };
  }

  #now(): Date {
    const now = this.#clock.now();
    if (Number.isNaN(now.valueOf())) {
      throw new Error("Trigger clock returned an invalid date.");
    }
    return new Date(now.valueOf());
  }
}

export interface TriggerPollingSchedulerOptions {
  service: TriggerService;
  intervalMs?: number;
  logger?: ExecutorLogger;
}

/** Lightweight process scheduler; durable deployments invoke `runDue` from jobs. */
export class TriggerPollingScheduler {
  readonly #service: TriggerService;
  readonly #intervalMs: number;
  readonly #logger: ExecutorLogger;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  readonly #idleWaiters = new Set<() => void>();

  constructor(options: TriggerPollingSchedulerOptions) {
    this.#service = options.service;
    this.#intervalMs = positiveSafeInteger(
      options.intervalMs ?? 1_000,
      "Trigger polling scheduler intervalMs",
    );
    this.#logger = options.logger ?? noopLogger;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = true;
      void this.#service
        .runDue()
        .catch((error: unknown) => {
          this.#logger.error("Trigger polling scheduler tick failed.", {
            errorName: error instanceof Error ? error.name : "unknown",
          });
        })
        .finally(() => {
          this.#running = false;
          for (const resolve of this.#idleWaiters) resolve();
          this.#idleWaiters.clear();
        });
    }, this.#intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  onIdle(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  tick(): Promise<TriggerPollTickResult> {
    return this.#service.runDue();
  }
}
