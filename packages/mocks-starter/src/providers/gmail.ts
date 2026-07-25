import { type Context, Hono } from "hono";
import {
  type AuthFailure,
  createMockClock,
  createStore,
  defineProviderMock,
  isObject,
  type JsonValue,
  type MockClock,
  type ProviderMock,
  readJsonObject,
  type SeedRecord,
  type StoredRecord,
} from "../kit/index.js";

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || value.length % 4 === 1) {
    throw new Error("The value is not valid base64url data.");
  }
  return Buffer.from(value, "base64url").toString("utf8");
}

interface Page<T> {
  items: T[];
  nextPageToken?: string;
}

function stringArray(
  value: unknown,
  field: string,
  options: { allowString?: boolean; required?: boolean } = {},
): string[] {
  const values =
    typeof value === "string" && options.allowString === true ? [value] : value;
  if (!Array.isArray(values)) {
    if (value === undefined && options.required !== true) {
      return [];
    }
    throw new Error(`${field} must be an array of non-empty strings.`);
  }
  if (
    values.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error(`${field} must contain only non-empty strings.`);
  }
  return [...new Set(values as string[])];
}

function paginate<T>(options: {
  items: readonly T[];
  store: string;
  pageToken?: string | undefined;
  pageSize?: string | undefined;
  defaultPageSize?: number;
  maxPageSize?: number;
}): Page<T> {
  const defaultPageSize = options.defaultPageSize ?? 100;
  const maxPageSize = options.maxPageSize ?? 500;
  const parsedPageSize =
    options.pageSize === undefined ? defaultPageSize : Number(options.pageSize);
  if (
    !Number.isSafeInteger(parsedPageSize) ||
    parsedPageSize < 1 ||
    parsedPageSize > maxPageSize
  ) {
    throw new Error(`Page size must be an integer from 1 to ${maxPageSize}.`);
  }
  const offset =
    options.pageToken === undefined
      ? 0
      : decodeCursor(options.pageToken, options.store);
  if (offset > options.items.length) {
    throw new Error("The page token points beyond the available results.");
  }
  const items = options.items.slice(offset, offset + parsedPageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < options.items.length
      ? {
          nextPageToken: encodeBase64Url(
            JSON.stringify({ store: options.store, offset: nextOffset }),
          ),
        }
      : {}),
  };
}

function decodeCursor(token: string, store: string): number {
  let value: unknown;
  try {
    value = JSON.parse(decodeBase64Url(token));
  } catch {
    throw new Error("The page token is invalid.");
  }
  if (
    !isObject(value) ||
    value.store !== store ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0
  ) {
    throw new Error("The page token is invalid for this resource.");
  }
  return value.offset as number;
}

function header(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | undefined {
  return headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

function sortNewest<T extends { id: string }>(
  items: readonly T[],
  timestamp: (item: T) => string,
): T[] {
  return [...items].sort(
    (left, right) =>
      timestamp(right).localeCompare(timestamp(left)) ||
      left.id.localeCompare(right.id),
  );
}

function normalizeSearchTerm(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPayload {
  mimeType: string;
  headers: GmailHeader[];
  body: {
    size: number;
    data: string;
  };
}

export interface GmailMessage {
  threadId: string;
  labelIds: string[];
  snippet: string;
  historyId: string;
  internalDate: string;
  payload: GmailPayload;
  sizeEstimate: number;
  raw: string;
}

export interface GmailThread {
  messageIds: string[];
  historyId: string;
  snippet: string;
}

export interface GmailDraft {
  messageId: string;
  createdAt: string;
}

export interface GmailLabel {
  name: string;
  type: "system" | "user";
  messageListVisibility: "show" | "hide";
  labelListVisibility: "labelShow" | "labelHide";
}

export interface CreateGmailMockOptions {
  clock?: MockClock;
}

export const GMAIL_ROUTE_COUNT = 8;

interface ParsedMessage {
  raw: string;
  threadId?: string;
  headers: GmailHeader[];
  body: string;
  mimeType: string;
}

interface GmailSeedMessage {
  id?: string;
  threadId?: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  mimeType?: string;
  labelIds?: string[];
  receivedAt?: string;
}

interface GmailSeedDraft {
  id?: string;
  messageId: string;
}

interface GmailSeedLabel extends GmailLabel {
  id: string;
}

type GmailStatus = 400 | 404 | 429;

const SEND_QUOTA_WINDOW_MS = 60_000;
const SEND_QUOTA_LIMIT = 5;
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
] as const;

const defaultLabels: readonly GmailSeedLabel[] = [
  {
    id: "INBOX",
    name: "INBOX",
    type: "system",
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
  },
  {
    id: "SENT",
    name: "SENT",
    type: "system",
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
  },
  {
    id: "UNREAD",
    name: "UNREAD",
    type: "system",
    messageListVisibility: "show",
    labelListVisibility: "labelShow",
  },
];

export const gmailFixtures = {
  default: {
    labels: defaultLabels,
    messages: [
      {
        id: "msg_default_000001",
        threadId: "thread_default_000001",
        from: "billing@example.com",
        to: ["recipient@example.com"],
        subject: "January invoice",
        body: "Your January invoice is ready.",
        labelIds: ["INBOX", "UNREAD"],
        receivedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "msg_default_000002",
        threadId: "thread_default_000002",
        from: "support@example.com",
        to: ["recipient@example.com"],
        subject: "Welcome to Example Support",
        body: "This is an obviously fake support fixture.",
        labelIds: ["INBOX"],
        receivedAt: "2025-12-31T23:59:00.000Z",
      },
    ],
    drafts: [],
  },
} as const;

function gmailReason(failure: AuthFailure): string {
  if (failure.kind === "insufficient_scope") {
    return "insufficientPermissions";
  }
  if (failure.kind === "rate_limited") {
    return "rateLimitExceeded";
  }
  return "authError";
}

function gmailStatusName(status: number): string {
  if (status === 401) {
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    return "PERMISSION_DENIED";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 429) {
    return "RESOURCE_EXHAUSTED";
  }
  return "INVALID_ARGUMENT";
}

function gmailErrorBody(status: number, reason: string, message: string) {
  return {
    error: {
      code: status,
      message,
      errors: [{ message, domain: "global", reason }],
      status: gmailStatusName(status),
    },
  };
}

function formatGmailAuthError(failure: AuthFailure): JsonValue {
  return gmailErrorBody(failure.status, gmailReason(failure), failure.message);
}

function gmailError(
  context: Context,
  status: GmailStatus,
  reason: string,
  message: string,
): Response {
  return context.json(gmailErrorBody(status, reason, message), status);
}

function parseHeaders(rawHeaders: string): GmailHeader[] {
  const headers: GmailHeader[] = [];
  for (const line of rawHeaders.replace(/\r\n/gu, "\n").split("\n")) {
    if (/^[ \t]/u.test(line) && headers.length > 0) {
      const previous = headers.at(-1);
      if (previous !== undefined) {
        previous.value = `${previous.value} ${line.trim()}`;
      }
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers.push({
      name: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return headers;
}

function parseRaw(raw: string): Omit<ParsedMessage, "threadId"> {
  const decoded = decodeBase64Url(raw);
  const separator = decoded.search(/\r?\n\r?\n/u);
  if (separator < 0) {
    throw new Error(
      "raw must encode an RFC 5322 message with headers and a body.",
    );
  }
  const separatorMatch = decoded.slice(separator).match(/^\r?\n\r?\n/u)?.[0];
  const headers = parseHeaders(decoded.slice(0, separator));
  const body = decoded.slice(separator + (separatorMatch?.length ?? 2));
  if (headers.length === 0) {
    throw new Error("raw must include at least one message header.");
  }
  const contentType = header(headers, "Content-Type")?.split(";", 1)[0]?.trim();
  return {
    raw,
    headers,
    body,
    mimeType: contentType ?? "text/plain",
  };
}

function parsedApiMessage(value: Record<string, unknown>): ParsedMessage {
  const threadId =
    typeof value.threadId === "string" && value.threadId.length > 0
      ? value.threadId
      : undefined;
  if (typeof value.raw === "string" && value.raw.length > 0) {
    return {
      ...parseRaw(value.raw),
      ...(threadId === undefined ? {} : { threadId }),
    };
  }

  if (!isObject(value.payload) || !Array.isArray(value.payload.headers)) {
    throw new Error(
      "A base64url raw message or simplified payload is required.",
    );
  }
  const headers: GmailHeader[] = value.payload.headers.map((item) => {
    if (
      !isObject(item) ||
      typeof item.name !== "string" ||
      typeof item.value !== "string"
    ) {
      throw new Error("payload.headers must contain name/value pairs.");
    }
    return { name: item.name, value: item.value };
  });
  const bodyData =
    isObject(value.payload.body) && typeof value.payload.body.data === "string"
      ? value.payload.body.data
      : "";
  const body = bodyData.length === 0 ? "" : decodeBase64Url(bodyData);
  const mimeType =
    typeof value.payload.mimeType === "string"
      ? value.payload.mimeType
      : "text/plain";
  const rawText = `${headers
    .map((item) => `${item.name}: ${item.value}`)
    .join("\r\n")}\r\n\r\n${body}`;
  return {
    raw: encodeBase64Url(rawText),
    headers,
    body,
    mimeType,
    ...(threadId === undefined ? {} : { threadId }),
  };
}

function makePayload(parsed: ParsedMessage): GmailPayload {
  return {
    mimeType: parsed.mimeType,
    headers: parsed.headers,
    body: {
      size: Buffer.byteLength(parsed.body, "utf8"),
      data: encodeBase64Url(parsed.body),
    },
  };
}

function snippet(body: string): string {
  return body.replace(/\s+/gu, " ").trim().slice(0, 120);
}

function rawForSeed(message: GmailSeedMessage): string {
  const mimeType = message.mimeType ?? "text/plain";
  return encodeBase64Url(
    [
      `From: ${message.from}`,
      `To: ${message.to.join(", ")}`,
      `Subject: ${message.subject}`,
      `Content-Type: ${mimeType}; charset=UTF-8`,
      "",
      message.body,
    ].join("\r\n"),
  );
}

function parseSeedMessage(value: unknown, index: number): GmailSeedMessage {
  if (!isObject(value)) {
    throw new Error("Gmail seed messages must be objects.");
  }
  const from =
    typeof value.from === "string" && value.from.length > 0
      ? value.from
      : undefined;
  const subject = typeof value.subject === "string" ? value.subject : undefined;
  const body = typeof value.body === "string" ? value.body : undefined;
  if (from === undefined || subject === undefined || body === undefined) {
    throw new Error("Gmail seed messages require from, subject, and body.");
  }
  return {
    ...(typeof value.id === "string" && value.id.length > 0
      ? { id: value.id }
      : {}),
    threadId:
      typeof value.threadId === "string" && value.threadId.length > 0
        ? value.threadId
        : `thread_seed_${String(index + 1).padStart(6, "0")}`,
    from,
    to: stringArray(value.to, "messages[].to", { required: true }),
    subject,
    body,
    ...(typeof value.mimeType === "string" && value.mimeType.length > 0
      ? { mimeType: value.mimeType }
      : {}),
    labelIds: stringArray(value.labelIds, "messages[].labelIds"),
    ...(typeof value.receivedAt === "string"
      ? { receivedAt: value.receivedAt }
      : {}),
  };
}

function messageSearchText(message: StoredRecord<GmailMessage>): string {
  return [
    header(message.payload.headers, "From"),
    header(message.payload.headers, "To"),
    header(message.payload.headers, "Subject"),
    decodeBase64Url(message.payload.body.data),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
}

function gmailMatches(
  message: StoredRecord<GmailMessage>,
  query: string,
): boolean {
  const tokens = query.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/gu) ?? [];
  const headers = message.payload.headers;
  const searchText = messageSearchText(message);
  return tokens.every((token) => {
    const separator = token.indexOf(":");
    if (separator > 0) {
      const field = token.slice(0, separator).toLowerCase();
      const term = normalizeSearchTerm(
        token.slice(separator + 1),
      ).toLowerCase();
      if (field === "from" || field === "to" || field === "subject") {
        return (header(headers, field) ?? "").toLowerCase().includes(term);
      }
      if (field === "label") {
        return message.labelIds.some(
          (labelId) => labelId.toLowerCase() === term,
        );
      }
      if (field === "in") {
        return message.labelIds.some(
          (labelId) => labelId.toLowerCase() === term,
        );
      }
      if (field === "is" && term === "unread") {
        return message.labelIds.includes("UNREAD");
      }
      if (field === "is" && term === "read") {
        return !message.labelIds.includes("UNREAD");
      }
    }
    return searchText.includes(normalizeSearchTerm(token).toLowerCase());
  });
}

function seedLabels(
  store: ReturnType<typeof createStore<GmailLabel>>,
  values: readonly GmailSeedLabel[] = defaultLabels,
): void {
  store.seed(values.map((value) => ({ ...value })));
}

/**
 * Creates the L2 Gmail HTTP mock. Its vendor surface starts at `/gmail/v1`,
 * matching the path appended to the manifest's `https://gmail.googleapis.com`
 * base URL. OAuth and control routes are supplied by the starter mock kit.
 */
export function createGmailMock(
  options: CreateGmailMockOptions = {},
): ProviderMock {
  const clock = options.clock ?? createMockClock();
  const messages = createStore<GmailMessage>("gmail_msg");
  const threads = createStore<GmailThread>("gmail_thread");
  const drafts = createStore<GmailDraft>("gmail_draft");
  const labels = createStore<GmailLabel>("gmail_label");
  seedLabels(labels);
  const app = new Hono();

  function sentInCurrentWindow(): number {
    const now = clock.now().getTime();
    const windowStart =
      Math.floor(now / SEND_QUOTA_WINDOW_MS) * SEND_QUOTA_WINDOW_MS;
    return messages
      .list()
      .filter(
        (message) =>
          message.labelIds.includes("SENT") &&
          Number(message.internalDate) >= windowStart &&
          Number(message.internalDate) < windowStart + SEND_QUOTA_WINDOW_MS,
      ).length;
  }

  function persistMessage(
    parsed: ParsedMessage,
    labelIds: string[],
  ): StoredRecord<GmailMessage> {
    const existingThread =
      parsed.threadId === undefined ? undefined : threads.get(parsed.threadId);
    const thread =
      existingThread ??
      threads.create({ messageIds: [], historyId: "0", snippet: "" });
    const historyId = String(messages.size + 1);
    const payload = makePayload(parsed);
    const message = messages.create({
      threadId: thread.id,
      labelIds,
      snippet: snippet(parsed.body),
      historyId,
      internalDate: String(clock.now().getTime()),
      payload,
      sizeEstimate: Buffer.byteLength(decodeBase64Url(parsed.raw), "utf8"),
      raw: parsed.raw,
    });
    threads.update(thread.id, {
      messageIds: [...thread.messageIds, message.id],
      historyId,
      snippet: message.snippet,
    });
    return message;
  }

  app.get("/gmail/v1/users/:userId/messages", (context) => {
    const url = new URL(context.req.url);
    const query = url.searchParams.get("q");
    const requiredLabels = url.searchParams.getAll("labelIds");
    let filtered = sortNewest(
      messages.list(),
      (message) => message.internalDate,
    );
    if (query !== null && query.trim().length > 0) {
      filtered = filtered.filter((message) => gmailMatches(message, query));
    }
    if (requiredLabels.length > 0) {
      filtered = filtered.filter((message) =>
        requiredLabels.every((labelId) => message.labelIds.includes(labelId)),
      );
    }
    try {
      const page = paginate({
        items: filtered,
        store: "gmail-messages",
        pageToken: url.searchParams.get("pageToken") ?? undefined,
        pageSize: url.searchParams.get("maxResults") ?? undefined,
      });
      return context.json({
        messages: page.items.map((message) => ({
          id: message.id,
          threadId: message.threadId,
        })),
        ...(page.nextPageToken === undefined
          ? {}
          : { nextPageToken: page.nextPageToken }),
        resultSizeEstimate: filtered.length,
      });
    } catch (error) {
      return gmailError(
        context,
        400,
        "invalidArgument",
        error instanceof Error ? error.message : "The list request is invalid.",
      );
    }
  });

  app.get("/gmail/v1/users/:userId/messages/:messageId", (context) => {
    const message = messages.get(context.req.param("messageId"));
    if (message === undefined) {
      return gmailError(
        context,
        404,
        "notFound",
        "Requested entity was not found.",
      );
    }
    return context.json(message);
  });

  app.post("/gmail/v1/users/:userId/messages/send", async (context) => {
    if (sentInCurrentWindow() >= SEND_QUOTA_LIMIT) {
      context.header("Retry-After", String(SEND_QUOTA_WINDOW_MS / 1000));
      return gmailError(
        context,
        429,
        "rateLimitExceeded",
        "User-rate limit exceeded. Retry after the current quota window.",
      );
    }
    let parsed: ParsedMessage;
    try {
      parsed = parsedApiMessage(await readJsonObject(context));
    } catch (error) {
      return gmailError(
        context,
        400,
        "invalidArgument",
        error instanceof Error ? error.message : "The message is invalid.",
      );
    }
    if (
      parsed.threadId !== undefined &&
      threads.get(parsed.threadId) === undefined
    ) {
      return gmailError(
        context,
        404,
        "notFound",
        "The reply thread was not found.",
      );
    }
    return context.json(persistMessage(parsed, ["SENT"]));
  });

  app.post("/gmail/v1/users/:userId/drafts", async (context) => {
    let body: Record<string, unknown>;
    let parsed: ParsedMessage;
    try {
      body = await readJsonObject(context);
      if (!isObject(body.message)) {
        throw new Error("message must be a Gmail message object.");
      }
      parsed = parsedApiMessage(body.message);
    } catch (error) {
      return gmailError(
        context,
        400,
        "invalidArgument",
        error instanceof Error ? error.message : "The draft is invalid.",
      );
    }
    if (
      parsed.threadId !== undefined &&
      threads.get(parsed.threadId) === undefined
    ) {
      return gmailError(
        context,
        404,
        "notFound",
        "The draft thread was not found.",
      );
    }
    const message = persistMessage(parsed, ["DRAFT"]);
    const draft = drafts.create({
      messageId: message.id,
      createdAt: clock.nowIso(),
    });
    return context.json({ id: draft.id, message });
  });

  app.get("/gmail/v1/users/:userId/threads", (context) => {
    const url = new URL(context.req.url);
    const query = url.searchParams.get("q");
    const requiredLabels = url.searchParams.getAll("labelIds");
    let filtered = threads.list().filter((thread) => {
      const threadMessages = thread.messageIds
        .map((id) => messages.get(id))
        .filter(
          (message): message is StoredRecord<GmailMessage> =>
            message !== undefined,
        );
      return (
        (query === null ||
          query.trim().length === 0 ||
          threadMessages.some((message) => gmailMatches(message, query))) &&
        (requiredLabels.length === 0 ||
          requiredLabels.every((labelId) =>
            threadMessages.some((message) =>
              message.labelIds.includes(labelId),
            ),
          ))
      );
    });
    filtered = [...filtered].sort(
      (left, right) =>
        Number(right.historyId) - Number(left.historyId) ||
        left.id.localeCompare(right.id),
    );
    try {
      const page = paginate({
        items: filtered,
        store: "gmail-threads",
        pageToken: url.searchParams.get("pageToken") ?? undefined,
        pageSize: url.searchParams.get("maxResults") ?? undefined,
      });
      return context.json({
        threads: page.items.map((thread) => ({
          id: thread.id,
          snippet: thread.snippet,
          historyId: thread.historyId,
        })),
        ...(page.nextPageToken === undefined
          ? {}
          : { nextPageToken: page.nextPageToken }),
        resultSizeEstimate: filtered.length,
      });
    } catch (error) {
      return gmailError(
        context,
        400,
        "invalidArgument",
        error instanceof Error ? error.message : "The list request is invalid.",
      );
    }
  });

  app.get("/gmail/v1/users/:userId/threads/:threadId", (context) => {
    const thread = threads.get(context.req.param("threadId"));
    if (thread === undefined) {
      return gmailError(
        context,
        404,
        "notFound",
        "Requested entity was not found.",
      );
    }
    return context.json({
      id: thread.id,
      historyId: thread.historyId,
      messages: thread.messageIds
        .map((id) => messages.get(id))
        .filter(
          (message): message is StoredRecord<GmailMessage> =>
            message !== undefined,
        ),
    });
  });

  app.post(
    "/gmail/v1/users/:userId/messages/:messageId/modify",
    async (context) => {
      const messageId = context.req.param("messageId");
      const message = messages.get(messageId);
      if (message === undefined) {
        return gmailError(
          context,
          404,
          "notFound",
          "Requested entity was not found.",
        );
      }
      let addLabelIds: string[];
      let removeLabelIds: string[];
      try {
        const body = await readJsonObject(context);
        addLabelIds = stringArray(body.addLabelIds, "addLabelIds");
        removeLabelIds = stringArray(body.removeLabelIds, "removeLabelIds");
        const knownLabels = new Set(labels.list().map((label) => label.id));
        const unknown = addLabelIds.find(
          (labelId) => !knownLabels.has(labelId),
        );
        if (unknown !== undefined) {
          throw new Error(`Label not found: ${unknown}`);
        }
      } catch (error) {
        return gmailError(
          context,
          400,
          "invalidArgument",
          error instanceof Error
            ? error.message
            : "The label update is invalid.",
        );
      }
      const nextLabels = message.labelIds.filter(
        (labelId) => !removeLabelIds.includes(labelId),
      );
      for (const labelId of addLabelIds) {
        if (!nextLabels.includes(labelId)) {
          nextLabels.push(labelId);
        }
      }
      return context.json(messages.update(messageId, { labelIds: nextLabels }));
    },
  );

  app.get("/gmail/v1/users/:userId/labels", (context) =>
    context.json({ labels: labels.list() }),
  );

  return defineProviderMock({
    slug: "gmail",
    app,
    clock,
    stores: { messages, threads, drafts, labels },
    formatErrors: formatGmailAuthError,
    oauth: {
      clients: [
        {
          clientId: "fixture-gmail-client",
          clientSecret: "fixture:gmail-client-secret",
          redirectUris: ["https://client.example.com/gmail/callback"],
          scopes: GMAIL_SCOPES,
        },
      ],
      accessTokenExpiresInMs: 60_000,
      refreshTokenExpiresInMs: 24 * 60 * 60 * 1000,
    },
    reset() {
      seedLabels(labels);
    },
    seed(data, stores) {
      if (!isObject(data) || !Array.isArray(data.messages)) {
        throw new Error("Gmail seed data must contain a messages array.");
      }
      const seedMessages = data.messages.map(parseSeedMessage);
      const preparedMessages: Array<SeedRecord<GmailMessage>> =
        seedMessages.map((seedMessage, index) => {
          const receivedAt = seedMessage.receivedAt ?? clock.nowIso();
          const receivedAtMs = new Date(receivedAt).getTime();
          if (!Number.isFinite(receivedAtMs)) {
            throw new Error(
              "Gmail seed receivedAt values must be valid timestamps.",
            );
          }
          const raw = rawForSeed(seedMessage);
          const parsed = parseRaw(raw);
          return {
            ...(seedMessage.id === undefined ? {} : { id: seedMessage.id }),
            threadId: seedMessage.threadId ?? `thread_seed_${index + 1}`,
            labelIds: seedMessage.labelIds ?? [],
            snippet: snippet(seedMessage.body),
            historyId: String(index + 1),
            internalDate: String(receivedAtMs),
            payload: makePayload(parsed),
            sizeEstimate: Buffer.byteLength(decodeBase64Url(raw), "utf8"),
            raw,
          };
        });
      const seededMessages = stores.messages.seed(preparedMessages);
      const messagesByThread = new Map<string, StoredRecord<GmailMessage>[]>();
      for (const message of seededMessages) {
        const grouped = messagesByThread.get(message.threadId) ?? [];
        grouped.push(message);
        messagesByThread.set(message.threadId, grouped);
      }
      stores.threads.seed(
        [...messagesByThread.entries()].map(([id, grouped]) => {
          const latest = grouped.at(-1);
          return {
            id,
            messageIds: grouped.map((message) => message.id),
            historyId: latest?.historyId ?? "0",
            snippet: latest?.snippet ?? "",
          };
        }),
      );
      const seedDrafts = data.drafts === undefined ? [] : data.drafts;
      if (!Array.isArray(seedDrafts)) {
        throw new Error("Gmail seed drafts must be an array.");
      }
      stores.drafts.seed(
        seedDrafts.map((value): SeedRecord<GmailDraft> => {
          if (!isObject(value) || typeof value.messageId !== "string") {
            throw new Error("Gmail seed drafts require a messageId.");
          }
          if (stores.messages.get(value.messageId) === undefined) {
            throw new Error(
              `Gmail seed draft message not found: ${value.messageId}`,
            );
          }
          const draft: GmailSeedDraft = {
            ...(typeof value.id === "string" ? { id: value.id } : {}),
            messageId: value.messageId,
          };
          return {
            ...(draft.id === undefined ? {} : { id: draft.id }),
            messageId: draft.messageId,
            createdAt: clock.nowIso(),
          };
        }),
      );
      const seedLabelValues = data.labels ?? defaultLabels;
      if (!Array.isArray(seedLabelValues)) {
        throw new Error("Gmail seed labels must be an array.");
      }
      stores.labels.seed(
        seedLabelValues.map((value): SeedRecord<GmailLabel> => {
          if (
            !isObject(value) ||
            typeof value.id !== "string" ||
            typeof value.name !== "string" ||
            (value.type !== "system" && value.type !== "user")
          ) {
            throw new Error("Gmail seed labels require id, name, and type.");
          }
          return {
            id: value.id,
            name: value.name,
            type: value.type,
            messageListVisibility:
              value.messageListVisibility === "hide" ? "hide" : "show",
            labelListVisibility:
              value.labelListVisibility === "labelHide"
                ? "labelHide"
                : "labelShow",
          };
        }),
      );
    },
    seedBundles: gmailFixtures,
  });
}
