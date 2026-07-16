import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolErrorCode,
  type ToolkitAdapter,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  assertNoAttachments,
  booleanValue,
  isoFromUnixSeconds,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  providerError,
  records,
  requiredStringField,
  stringArrayValue,
  stringValue,
  unsupportedTool,
} from "./common.js";

export const SLACK_ERROR_CODE_MAP: Readonly<Record<string, ToolErrorCode>> =
  Object.freeze({
    invalid_auth: TOOL_ERROR_CODES.AUTH_EXPIRED,
    missing_scope: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
    ratelimited: TOOL_ERROR_CODES.RATE_LIMITED,
    channel_not_found: TOOL_ERROR_CODES.NOT_FOUND,
    message_not_found: TOOL_ERROR_CODES.NOT_FOUND,
    thread_not_found: TOOL_ERROR_CODES.NOT_FOUND,
    invalid_arguments: TOOL_ERROR_CODES.INVALID_INPUT,
    invalid_name: TOOL_ERROR_CODES.INVALID_INPUT,
  } as const satisfies Readonly<Record<string, ToolErrorCode>>);

function slackRetryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get("Retry-After"));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function slackRequest(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await createProviderHttpClient(context)(path, init);
  const body = await jsonObject(context, response);
  if (body.ok === true) {
    return body;
  }

  const providerCode = stringValue(body, "error") ?? "unknown_error";
  const code =
    SLACK_ERROR_CODE_MAP[providerCode] ?? TOOL_ERROR_CODES.PROVIDER_ERROR;
  const retryAfter =
    code === TOOL_ERROR_CODES.RATE_LIMITED
      ? slackRetryAfter(response)
      : undefined;
  throw new EyeballError({
    code,
    message: `Slack returned ${providerCode}.`,
    ...(retryAfter === undefined ? {} : { retryAfter }),
    providerDetail: {
      toolkit: context.tool.toolkit,
      status: response.status,
      code: providerCode,
    },
  });
}

function responseCursor(
  body: Readonly<Record<string, unknown>>,
): string | undefined {
  const metadata = body.response_metadata;
  if (!isRecord(metadata)) {
    return undefined;
  }
  const cursor = stringValue(metadata, "next_cursor");
  return cursor === undefined || cursor.length === 0 ? undefined : cursor;
}

function slackMember(
  context: AdapterContext,
  user: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const memberId = requiredStringField(context, user, "id");
  const profile = isRecord(user.profile) ? user.profile : {};
  const handle = stringValue(user, "name");
  const displayName =
    stringValue(profile, "display_name") ||
    stringValue(user, "real_name") ||
    stringValue(profile, "real_name") ||
    handle ||
    memberId;
  const email = stringValue(profile, "email");
  return {
    memberId,
    displayName,
    ...(handle === undefined || handle.length === 0 ? {} : { handle }),
    ...(email === undefined || email.length === 0 ? {} : { email }),
    isBot: user.is_bot === true,
  };
}

async function allSlackUsers(
  context: AdapterContext,
): Promise<Map<string, Readonly<Record<string, unknown>>>> {
  const users = new Map<string, Readonly<Record<string, unknown>>>();
  const visited = new Set<string>();
  let cursor: string | undefined;
  do {
    const search = new URLSearchParams({ limit: "200" });
    if (cursor !== undefined) {
      search.set("cursor", cursor);
    }
    const body = await slackRequest(
      context,
      `api/users.list?${search.toString()}`,
    );
    for (const user of records(body.members)) {
      const id = stringValue(user, "id");
      if (id !== undefined) {
        users.set(id, user);
      }
    }
    cursor = responseCursor(body);
    if (cursor !== undefined && visited.has(cursor)) {
      throw providerError(context, "Slack repeated a users.list cursor.");
    }
    if (cursor !== undefined) {
      visited.add(cursor);
    }
  } while (cursor !== undefined);
  return users;
}

function slackSender(
  userId: string,
  users: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Readonly<Record<string, unknown>> {
  const user = users.get(userId);
  if (user === undefined) {
    return { memberId: userId, displayName: userId };
  }
  const profile = isRecord(user.profile) ? user.profile : {};
  const handle = stringValue(user, "name");
  return {
    memberId: userId,
    displayName:
      stringValue(profile, "display_name") ||
      stringValue(user, "real_name") ||
      stringValue(profile, "real_name") ||
      handle ||
      userId,
    ...(handle === undefined || handle.length === 0 ? {} : { handle }),
    isBot: user.is_bot === true,
  };
}

function slackMessage(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
  conversationId: string,
  users: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Readonly<Record<string, unknown>> {
  const messageId = requiredStringField(context, message, "ts");
  const userId = requiredStringField(context, message, "user");
  const threadId = stringValue(message, "thread_ts");
  const replyCount = numberValue(message, "reply_count") ?? 0;
  const reactions = records(message.reactions).map((reaction) => ({
    reaction: requiredStringField(context, reaction, "name"),
    count: numberValue(reaction, "count") ?? 0,
  }));
  return {
    messageId,
    conversationId,
    sender: slackSender(userId, users),
    text: stringValue(message, "text") ?? "",
    sentAt: isoFromUnixSeconds(context, messageId, "ts"),
    ...(threadId === undefined && replyCount === 0
      ? {}
      : { threadId: threadId ?? messageId }),
    ...(threadId === undefined ? {} : { replyToMessageId: threadId }),
    reactions,
  };
}

function slackChannel(
  context: AdapterContext,
  channel: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const topic = isRecord(channel.topic)
    ? stringValue(channel.topic, "value")
    : undefined;
  const type =
    channel.is_im === true
      ? "direct"
      : channel.is_mpim === true
        ? "group"
        : channel.is_private === true
          ? "private"
          : "public";
  const memberCount = numberValue(channel, "num_members");
  return {
    conversationId: requiredStringField(context, channel, "id"),
    name: stringValue(channel, "name") ?? "",
    type,
    ...(topic === undefined ? {} : { topic }),
    ...(memberCount === undefined ? {} : { memberCount }),
    archived: channel.is_archived === true,
  };
}

function slackConversationTypes(
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const mapped = stringArrayValue(input, "types").flatMap((type) => {
    switch (type) {
      case "public":
        return ["public_channel"];
      case "private":
        return ["private_channel"];
      case "direct":
        return ["im"];
      case "group":
        return ["mpim"];
      default:
        return [];
    }
  });
  return mapped.length === 0 ? undefined : mapped.join(",");
}

function matchesMessageTime(
  input: Readonly<Record<string, unknown>>,
  message: Readonly<Record<string, unknown>>,
): boolean {
  const sentAt = String(message.sentAt);
  const sentAfter = stringValue(input, "sentAfter");
  const sentBefore = stringValue(input, "sentBefore");
  return (
    (sentAfter === undefined || sentAt >= sentAfter) &&
    (sentBefore === undefined || sentAt < sentBefore)
  );
}

export class SlackAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "slack";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "slack.send_message":
        return this.sendMessage(context);
      case "slack.list_channels":
        return this.listChannels(context);
      case "slack.list_messages":
        return this.listMessages(context);
      case "slack.get_message":
        return this.getMessage(context);
      case "slack.reply_to_message":
        return this.replyToMessage(context);
      case "slack.add_reaction":
        return this.addReaction(context);
      case "slack.create_channel":
        return this.createChannel(context);
      case "slack.list_members":
        return this.listMembers(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async sendMessage(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const replyToMessageId = stringValue(input, "replyToMessageId");
    const body = await slackRequest(
      context,
      "api/chat.postMessage",
      jsonRequest({
        channel: conversationId,
        text: requiredStringField(context, input, "text"),
        ...(replyToMessageId === undefined
          ? {}
          : { thread_ts: replyToMessageId }),
      }),
    );
    const messageId = requiredStringField(context, body, "ts");
    return asJson({
      messageId,
      conversationId: stringValue(body, "channel") ?? conversationId,
      sentAt: isoFromUnixSeconds(context, messageId, "ts"),
    });
  }

  private async listChannels(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({
      exclude_archived:
        booleanValue(input, "includeArchived") === true ? "false" : "true",
      limit: String(numberValue(input, "pageSize") ?? 100),
    });
    const cursor = stringValue(input, "pageToken");
    if (cursor !== undefined) {
      search.set("cursor", cursor);
    }
    const types = slackConversationTypes(input);
    if (types !== undefined) {
      search.set("types", types);
    }
    const body = await slackRequest(
      context,
      `api/conversations.list?${search.toString()}`,
    );
    const nextPageToken = responseCursor(body);
    return asJson({
      channels: records(body.channels).map((channel) =>
        slackChannel(context, channel),
      ),
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }

  private async listMessages(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const search = new URLSearchParams({
      channel: conversationId,
      inclusive: "true",
      limit: String(numberValue(input, "pageSize") ?? 100),
    });
    const cursor = stringValue(input, "pageToken");
    if (cursor !== undefined) {
      search.set("cursor", cursor);
    }
    const sentAfter = stringValue(input, "sentAfter");
    if (sentAfter !== undefined) {
      search.set("oldest", String(new Date(sentAfter).getTime() / 1_000));
    }
    const sentBefore = stringValue(input, "sentBefore");
    if (sentBefore !== undefined) {
      search.set("latest", String(new Date(sentBefore).getTime() / 1_000));
    }
    const history = await slackRequest(
      context,
      `api/conversations.history?${search.toString()}`,
    );
    const topLevel = records(history.messages);
    const expanded: Readonly<Record<string, unknown>>[] = [];
    for (const root of topLevel) {
      expanded.push(root);
      if (
        booleanValue(input, "includeThreadReplies") !== true ||
        (numberValue(root, "reply_count") ?? 0) === 0
      ) {
        continue;
      }
      const rootTs = requiredStringField(context, root, "ts");
      const replies = await slackRequest(
        context,
        `api/conversations.replies?${new URLSearchParams({
          channel: conversationId,
          ts: rootTs,
          limit: "200",
        }).toString()}`,
      );
      expanded.push(
        ...records(replies.messages).filter(
          (message) => stringValue(message, "ts") !== rootTs,
        ),
      );
    }
    const users = await allSlackUsers(context);
    const messages = expanded
      .map((message) => slackMessage(context, message, conversationId, users))
      .filter((message) => matchesMessageTime(input, message));
    const nextPageToken = responseCursor(history);
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
    const body = await slackRequest(
      context,
      `api/conversations.replies?${new URLSearchParams({
        channel: conversationId,
        ts: messageId,
        limit: "200",
      }).toString()}`,
    );
    const message = records(body.messages).find(
      (candidate) => stringValue(candidate, "ts") === messageId,
    );
    if (message === undefined) {
      throw providerError(
        context,
        "Slack did not return the requested message in its thread.",
      );
    }
    return asJson(
      slackMessage(
        context,
        message,
        conversationId,
        await allSlackUsers(context),
      ),
    );
  }

  private async replyToMessage(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const parentMessageId = requiredStringField(context, input, "messageId");
    const body = await slackRequest(
      context,
      "api/chat.postMessage",
      jsonRequest({
        channel: conversationId,
        text: requiredStringField(context, input, "text"),
        thread_ts: parentMessageId,
      }),
    );
    const messageId = requiredStringField(context, body, "ts");
    return asJson({
      messageId,
      conversationId: stringValue(body, "channel") ?? conversationId,
      parentMessageId,
      sentAt: isoFromUnixSeconds(context, messageId, "ts"),
    });
  }

  private async addReaction(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const messageId = requiredStringField(context, input, "messageId");
    const reaction = requiredStringField(context, input, "reaction");
    await slackRequest(
      context,
      "api/reactions.add",
      jsonRequest({
        channel: requiredStringField(context, input, "conversationId"),
        timestamp: messageId,
        name: reaction,
      }),
    );
    return asJson({ messageId, reaction, added: true });
  }

  private async createChannel(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    if (
      stringValue(input, "topic") !== undefined ||
      stringArrayValue(input, "memberIds").length > 0
    ) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_SUPPORTED,
        message:
          "Slack topic assignment and initial member invitations require follow-up routes that are not available in this adapter slice.",
      });
    }
    const body = await slackRequest(
      context,
      "api/conversations.create",
      jsonRequest({
        name: requiredStringField(context, input, "name"),
        is_private: stringValue(input, "visibility") === "private",
      }),
    );
    if (!isRecord(body.channel)) {
      throw providerError(context, "Slack omitted the created channel.");
    }
    const channel = body.channel;
    return asJson({
      conversationId: requiredStringField(context, channel, "id"),
      name: requiredStringField(context, channel, "name"),
      visibility: channel.is_private === true ? "private" : "public",
      createdAt: isoFromUnixSeconds(context, channel.created, "created"),
    });
  }

  private async listMembers(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = stringValue(input, "conversationId");
    if (conversationId !== undefined) {
      const search = new URLSearchParams({
        channel: conversationId,
        limit: String(numberValue(input, "pageSize") ?? 100),
      });
      const cursor = stringValue(input, "pageToken");
      if (cursor !== undefined) {
        search.set("cursor", cursor);
      }
      const body = await slackRequest(
        context,
        `api/conversations.members?${search.toString()}`,
      );
      const users = await allSlackUsers(context);
      const members = Array.isArray(body.members)
        ? body.members.flatMap((memberId) => {
            if (typeof memberId !== "string") {
              return [];
            }
            const user = users.get(memberId);
            return [
              user === undefined
                ? { memberId, displayName: memberId, isBot: false }
                : slackMember(context, user),
            ];
          })
        : [];
      const nextPageToken = responseCursor(body);
      return asJson({
        members,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      });
    }

    const search = new URLSearchParams({
      limit: String(numberValue(input, "pageSize") ?? 100),
    });
    const cursor = stringValue(input, "pageToken");
    if (cursor !== undefined) {
      search.set("cursor", cursor);
    }
    const body = await slackRequest(
      context,
      `api/users.list?${search.toString()}`,
    );
    const nextPageToken = responseCursor(body);
    return asJson({
      members: records(body.members).map((user) => slackMember(context, user)),
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }
}

export const slackAdapter = new SlackAdapter();
