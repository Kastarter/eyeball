import {
  EyeballError,
  fromHttpStatus,
  type JsonValue,
  TOOL_ERROR_CODES,
  type TriggerAdapter,
  type TriggerAdapterContext,
  type TriggerPollResult,
  type TriggerPushResult,
} from "@eyeball/core";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  provider: string,
): string {
  const selected = value[key];
  if (typeof selected !== "string" || selected.length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: `${provider} omitted required trigger field ${key}.`,
    });
  }
  return selected;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const selected = value[key];
  return typeof selected === "string" && selected.length > 0
    ? selected
    : undefined;
}

function stringArray(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string[] {
  const selected = value[key];
  return Array.isArray(selected)
    ? selected.filter((item): item is string => typeof item === "string")
    : [];
}

function authorizationHeader(
  context: TriggerAdapterContext,
): string | undefined {
  switch (context.credential.type) {
    case "oauth2":
      return `Bearer ${context.credential.accessToken}`;
    case "api_key": {
      const value =
        context.credential.values.apiKey ??
        context.credential.values.token ??
        Object.values(context.credential.values)[0];
      return value === undefined ? undefined : `Bearer ${value}`;
    }
    case "basic":
      return `Basic ${Buffer.from(
        `${context.credential.username}:${context.credential.password}`,
      ).toString("base64")}`;
    case "none":
      return undefined;
  }
}

async function providerJson(
  context: TriggerAdapterContext,
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const base = new URL(
    context.baseUrl.endsWith("/") ? context.baseUrl : `${context.baseUrl}/`,
  );
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message: "Provider trigger requests must stay on the configured origin.",
    });
  }
  const headers = new Headers();
  const authorization = authorizationHeader(context);
  if (authorization !== undefined) headers.set("Authorization", authorization);
  let response: Response;
  try {
    response = await context.fetchImpl(url, { headers, redirect: "manual" });
  } catch (error) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_UNAVAILABLE,
      message: "The trigger provider could not be reached.",
      cause: error,
    });
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = text;
  }
  if (!response.ok) throw fromHttpStatus(response.status, body);
  if (!isRecord(body)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "The trigger provider returned a non-object response.",
    });
  }
  return body;
}

function headerValue(
  message: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  if (!isRecord(message.payload) || !Array.isArray(message.payload.headers)) {
    return undefined;
  }
  for (const candidate of message.payload.headers) {
    if (
      isRecord(candidate) &&
      typeof candidate.name === "string" &&
      candidate.name.toLowerCase() === name.toLowerCase() &&
      typeof candidate.value === "string"
    ) {
      return candidate.value;
    }
  }
  return undefined;
}

function emailAddress(value: string): string {
  const bracketed = /<([^<>]+)>/u.exec(value)?.[1];
  return (bracketed ?? value).trim();
}

function emailAddresses(value: string): string[] {
  return value
    .split(",")
    .map(emailAddress)
    .filter((address) => address.length > 0);
}

function receivedAtFromMilliseconds(value: string, provider: string): string {
  const date = new Date(Number(value));
  if (Number.isNaN(date.valueOf())) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: `${provider} returned an invalid event timestamp.`,
    });
  }
  return date.toISOString();
}

function historyNumber(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "Gmail returned an invalid historyId value.",
    });
  }
}

function gmailMatchesFilters(
  payload: Readonly<Record<string, JsonValue>>,
  filters: Readonly<Record<string, JsonValue>> | undefined,
): boolean {
  if (filters === undefined) return true;
  return (
    (typeof filters.from !== "string" || payload.from === filters.from) &&
    (typeof filters.to !== "string" ||
      (Array.isArray(payload.to) && payload.to.includes(filters.to))) &&
    (typeof filters.subjectContains !== "string" ||
      (typeof payload.subject === "string" &&
        payload.subject
          .toLowerCase()
          .includes(filters.subjectContains.toLowerCase())))
  );
}

export class GmailEmailReceivedTriggerAdapter implements TriggerAdapter {
  readonly toolkitSlug = "gmail";

  async poll(
    context: TriggerAdapterContext,
    cursor: string | undefined,
  ): Promise<TriggerPollResult> {
    const references: Array<{ id: string }> = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: "100" });
      query.append("labelIds", "INBOX");
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const page = await providerJson(
        context,
        `gmail/v1/users/me/messages?${query.toString()}`,
      );
      for (const value of Array.isArray(page.messages) ? page.messages : []) {
        if (isRecord(value) && typeof value.id === "string") {
          references.push({ id: value.id });
        }
      }
      pageToken = optionalString(page, "nextPageToken");
    } while (pageToken !== undefined);

    const previous = cursor === undefined ? undefined : historyNumber(cursor);
    let highWatermark = previous;
    const candidates: Array<{
      history: bigint;
      event: TriggerPollResult["events"][number];
    }> = [];
    for (const reference of references) {
      const message = await providerJson(
        context,
        `gmail/v1/users/me/messages/${encodeURIComponent(reference.id)}?format=full`,
      );
      const id = requiredString(message, "id", "Gmail");
      const historyId = requiredString(message, "historyId", "Gmail");
      const history = historyNumber(historyId);
      if (highWatermark === undefined || history > highWatermark) {
        highWatermark = history;
      }
      if (previous !== undefined && history <= previous) continue;
      const threadId = requiredString(message, "threadId", "Gmail");
      const labelIds = stringArray(message, "labelIds");
      const receivedAt = receivedAtFromMilliseconds(
        requiredString(message, "internalDate", "Gmail"),
        "Gmail",
      );
      const fromHeader = headerValue(message, "From");
      if (fromHeader === undefined) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.PROVIDER_ERROR,
          message: "Gmail omitted the From header for a received message.",
        });
      }
      const payload: Readonly<Record<string, JsonValue>> = {
        id,
        from: emailAddress(fromHeader),
        to: emailAddresses(headerValue(message, "To") ?? ""),
        subject: headerValue(message, "Subject") ?? "",
        snippet: optionalString(message, "snippet") ?? "",
        threadId,
        receivedAt,
        x_provider: { gmail: { historyId, labelIds } },
      };
      if (!gmailMatchesFilters(payload, context.subscription.filters)) continue;
      candidates.push({
        history,
        event: { providerEventId: id, occurredAt: receivedAt, payload },
      });
    }
    candidates.sort((left, right) =>
      left.history < right.history ? -1 : left.history > right.history ? 1 : 0,
    );
    return {
      events: candidates.map(({ event }) => event),
      ...(highWatermark === undefined
        ? {}
        : { cursor: highWatermark.toString() }),
    };
  }
}

function slackTimestamp(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: "Slack event.ts must be a non-negative numeric timestamp.",
    });
  }
  return new Date(seconds * 1_000).toISOString();
}

function slackMatchesFilters(
  conversationId: string,
  from: string,
  filters: Readonly<Record<string, JsonValue>> | undefined,
): boolean {
  if (filters === undefined) return true;
  return (
    (typeof filters.conversationId !== "string" ||
      filters.conversationId === conversationId) &&
    (typeof filters.from !== "string" || filters.from === from)
  );
}

export class SlackMessageReceivedTriggerAdapter implements TriggerAdapter {
  readonly toolkitSlug = "slack";

  async ingestPush(
    context: TriggerAdapterContext,
    rawBody: string,
  ): Promise<TriggerPushResult> {
    let body: unknown;
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: "Slack ingest body must be valid JSON.",
      });
    }
    if (!isRecord(body)) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: "Slack ingest body must be a JSON object.",
      });
    }
    if (body.type === "url_verification") {
      if (typeof body.challenge !== "string" || body.challenge.length === 0) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.INVALID_INPUT,
          message: "Slack URL verification omitted its challenge.",
        });
      }
      return { kind: "challenge", challenge: body.challenge };
    }
    if (body.type !== "event_callback" || !isRecord(body.event)) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: "Slack ingest body must be an event_callback.",
      });
    }
    if (body.event.type !== "message") {
      return { kind: "events", events: [] };
    }
    const eventId = requiredString(body, "event_id", "Slack");
    const teamId = requiredString(body, "team_id", "Slack");
    const event = body.event;
    const channelId = requiredString(event, "channel", "Slack");
    const eventTs = requiredString(event, "ts", "Slack");
    const from =
      optionalString(event, "user") ?? requiredString(event, "bot_id", "Slack");
    if (!slackMatchesFilters(channelId, from, context.subscription.filters)) {
      return { kind: "events", events: [] };
    }
    const occurredAt = slackTimestamp(eventTs);
    const threadId = optionalString(event, "thread_ts");
    const subtype = optionalString(event, "subtype");
    const payload: Readonly<Record<string, JsonValue>> = {
      id: optionalString(event, "client_msg_id") ?? eventTs,
      from,
      conversationId: channelId,
      text: typeof event.text === "string" ? event.text : "",
      ...(threadId === undefined ? {} : { threadId }),
      receivedAt: occurredAt,
      x_provider: {
        slack: {
          eventId,
          teamId,
          channelId,
          eventTs,
          ...(subtype === undefined ? {} : { subtype }),
        },
      },
    };
    return {
      kind: "events",
      events: [{ providerEventId: eventId, occurredAt, payload }],
    };
  }
}

export class TriggerAdapterRegistry {
  readonly #adapters = new Map<string, TriggerAdapter>();

  constructor(adapters: readonly TriggerAdapter[]) {
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.toolkitSlug)) {
        throw new Error(`Duplicate trigger adapter: ${adapter.toolkitSlug}`);
      }
      this.#adapters.set(adapter.toolkitSlug, adapter);
    }
  }

  get(toolkitSlug: string): TriggerAdapter | undefined {
    return this.#adapters.get(toolkitSlug);
  }
}

export const defaultTriggerAdapters = Object.freeze([
  new GmailEmailReceivedTriggerAdapter(),
  new SlackMessageReceivedTriggerAdapter(),
]);
