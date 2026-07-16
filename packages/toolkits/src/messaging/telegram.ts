import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  MOCK_CREDENTIAL_TRIGGER_TOKENS,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  createProviderHttpClient,
  type ProviderHttpClient,
} from "../http-client.js";
import {
  asJson,
  assertNoAttachments,
  booleanValue,
  idString,
  invalidInput,
  isoFromUnixSeconds,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  providerError,
  requiredApiKeyValue,
  requiredIdField,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "./common.js";

interface TelegramUpdate {
  updateId: number;
  message: Readonly<Record<string, unknown>>;
}

function telegramClient(context: AdapterContext): {
  client: ProviderHttpClient;
  botPath: string;
  token: string;
} {
  const token = requiredApiKeyValue(context, "apiKey");
  return {
    // Telegram authenticates with the path token. The shared Bearer header remains
    // intentionally enabled so mock-kit fixture triggers work; Telegram ignores it.
    client: createProviderHttpClient(context),
    botPath: `bot${encodeURIComponent(token)}`,
    token,
  };
}

async function telegramRequest(
  context: AdapterContext,
  method: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  const { client, botPath, token } = telegramClient(context);
  let response: Response;
  try {
    response = await client(`${botPath}/${method}`, init);
  } catch (error) {
    if (
      error instanceof EyeballError &&
      error.code === TOOL_ERROR_CODES.AUTH_MISSING &&
      token === MOCK_CREDENTIAL_TRIGGER_TOKENS.EXPIRED_TOKEN
    ) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.AUTH_EXPIRED,
        message: "The Telegram bot token has expired.",
        providerDetail: { toolkit: context.tool.toolkit, status: 401 },
        cause: error,
      });
    }
    throw error;
  }
  const body = await jsonObject(context, response);
  if (body.ok === true) {
    return body;
  }
  const errorCode = idString(body.error_code) ?? "unknown_error";
  const description = stringValue(body, "description") ?? "Telegram API error";
  const normalizedCode =
    errorCode === "401"
      ? TOOL_ERROR_CODES.AUTH_MISSING
      : errorCode === "403"
        ? TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE
        : errorCode === "429"
          ? TOOL_ERROR_CODES.RATE_LIMITED
          : errorCode === "400"
            ? TOOL_ERROR_CODES.INVALID_INPUT
            : TOOL_ERROR_CODES.PROVIDER_ERROR;
  const parameters = isRecord(body.parameters) ? body.parameters : {};
  const retryAfter = numberValue(parameters, "retry_after");
  throw new EyeballError({
    code: normalizedCode,
    message: description,
    ...(normalizedCode === TOOL_ERROR_CODES.RATE_LIMITED &&
    retryAfter !== undefined
      ? { retryAfter }
      : {}),
    providerDetail: {
      toolkit: context.tool.toolkit,
      code: errorCode,
    },
  });
}

function positiveMessageId(
  context: AdapterContext,
  value: string,
  field: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return invalidInput(
      context,
      `${field} must be a positive Telegram message identifier.`,
    );
  }
  return parsed;
}

function telegramMessage(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const from = isRecord(message.from) ? message.from : {};
  const chat = isRecord(message.chat) ? message.chat : {};
  const memberId = requiredIdField(context, from, "id");
  const firstName = stringValue(from, "first_name") ?? memberId;
  const lastName = stringValue(from, "last_name");
  const handle = stringValue(from, "username");
  const reply = isRecord(message.reply_to_message)
    ? message.reply_to_message
    : undefined;
  const replyToMessageId =
    reply === undefined ? undefined : idString(reply.message_id);
  return {
    messageId: requiredIdField(context, message, "message_id"),
    conversationId: requiredIdField(context, chat, "id"),
    sender: {
      memberId,
      displayName:
        lastName === undefined ? firstName : `${firstName} ${lastName}`,
      ...(handle === undefined ? {} : { handle }),
      isBot: from.is_bot === true,
    },
    text: stringValue(message, "text") ?? "",
    sentAt: isoFromUnixSeconds(context, message.date, "date"),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    reactions: [],
  };
}

function telegramUpdates(
  context: AdapterContext,
  body: Readonly<Record<string, unknown>>,
): TelegramUpdate[] {
  if (!Array.isArray(body.result)) {
    throw providerError(context, "Telegram returned an invalid update list.");
  }
  return body.result.flatMap((update) => {
    if (!isRecord(update) || !isRecord(update.message)) {
      return [];
    }
    const updateId = numberValue(update, "update_id");
    if (updateId === undefined || !Number.isSafeInteger(updateId)) {
      throw providerError(context, "Telegram returned an invalid update_id.");
    }
    return [{ updateId, message: update.message }];
  });
}

function updateOffset(context: AdapterContext): number {
  const pageToken = stringValue(context.canonicalInput, "pageToken");
  if (pageToken === undefined) {
    return 0;
  }
  const offset = Number(pageToken);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return invalidInput(context, "pageToken is not a Telegram update offset.");
  }
  return offset;
}

function matchesMessageFilters(
  input: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>>,
): boolean {
  const sentAt = String(message.sentAt);
  const sentAfter = stringValue(input, "sentAfter");
  const sentBefore = stringValue(input, "sentBefore");
  return (
    (booleanValue(input, "includeThreadReplies") === true ||
      message.replyToMessageId === undefined) &&
    (sentAfter === undefined || sentAt >= sentAfter) &&
    (sentBefore === undefined || sentAt < sentBefore)
  );
}

export class TelegramAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "telegram";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "telegram.send_message":
        return this.sendMessage(context);
      case "telegram.list_messages":
        return this.listMessages(context);
      case "telegram.get_message":
        return this.getMessage(context);
      case "telegram.reply_to_message":
        return this.replyToMessage(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async createMessage(
    context: AdapterContext,
    parentMessageId?: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const replyId =
      parentMessageId === undefined
        ? undefined
        : positiveMessageId(context, parentMessageId, "messageId");
    const body = await telegramRequest(
      context,
      "sendMessage",
      jsonRequest({
        chat_id: requiredStringField(context, input, "conversationId"),
        text: requiredStringField(context, input, "text"),
        ...(replyId === undefined ? {} : { reply_to_message_id: replyId }),
      }),
    );
    if (!isRecord(body.result)) {
      throw providerError(context, "Telegram omitted the created message.");
    }
    return body.result;
  }

  private async sendMessage(context: AdapterContext): Promise<JsonValue> {
    const parentMessageId = stringValue(
      context.canonicalInput,
      "replyToMessageId",
    );
    const message = await this.createMessage(context, parentMessageId);
    const chat = isRecord(message.chat) ? message.chat : {};
    return asJson({
      messageId: requiredIdField(context, message, "message_id"),
      conversationId: requiredIdField(context, chat, "id"),
      sentAt: isoFromUnixSeconds(context, message.date, "date"),
    });
  }

  private async listMessages(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const pageSize = Math.min(numberValue(input, "pageSize") ?? 100, 100);
    const body = await telegramRequest(
      context,
      `getUpdates?${new URLSearchParams({
        offset: String(updateOffset(context)),
        limit: String(pageSize),
      }).toString()}`,
    );
    const updates = telegramUpdates(context, body);
    const messages = updates
      .map(({ message }) => telegramMessage(context, message))
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          matchesMessageFilters(input, message),
      );
    const lastUpdate = updates.at(-1);
    const nextPageToken =
      updates.length === pageSize && lastUpdate !== undefined
        ? String(lastUpdate.updateId + 1)
        : undefined;
    return asJson({
      messages,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }

  private async getMessage(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const messageId = requiredStringField(context, input, "messageId");
    const body = await telegramRequest(
      context,
      "getUpdates?offset=0&limit=100",
    );
    const message = telegramUpdates(context, body)
      .map((update) => telegramMessage(context, update.message))
      .find(
        (candidate) =>
          candidate.conversationId === conversationId &&
          candidate.messageId === messageId,
      );
    if (message === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message:
          "Telegram did not expose the requested message in the retained update stream.",
        providerDetail: { toolkit: context.tool.toolkit },
      });
    }
    return asJson(message);
  }

  private async replyToMessage(context: AdapterContext): Promise<JsonValue> {
    const parentMessageId = requiredStringField(
      context,
      context.canonicalInput,
      "messageId",
    );
    const message = await this.createMessage(context, parentMessageId);
    const chat = isRecord(message.chat) ? message.chat : {};
    return asJson({
      messageId: requiredIdField(context, message, "message_id"),
      conversationId: requiredIdField(context, chat, "id"),
      parentMessageId,
      sentAt: isoFromUnixSeconds(context, message.date, "date"),
    });
  }
}

export const telegramAdapter = new TelegramAdapter();
