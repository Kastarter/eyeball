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
  invalidInput,
  isoString,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  providerError,
  records,
  requiredApiKeyValue,
  requiredInputString,
  requiredStringField,
  stringArrayValue,
  stringValue,
  unsupportedTool,
} from "./common.js";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const VIEW_CHANNEL_PERMISSION = "1024";

function discordClient(context: AdapterContext): ProviderHttpClient {
  const token = requiredApiKeyValue(context, "apiKey");
  const fixtureToken =
    token.startsWith("fixture:") ||
    token === "EXPIRED_TOKEN" ||
    token === "INSUFFICIENT_SCOPE_TOKEN" ||
    token === "RATE_LIMITED_TOKEN";
  const client = createProviderHttpClient(context, {
    // Discord uses Bot auth in production; the shared mock kit recognizes Bearer fixtures.
    authorization: `${fixtureToken ? "Bearer" : "Bot"} ${token}`,
  });
  return async (path, init) => {
    try {
      return await client(path, init);
    } catch (error) {
      if (
        error instanceof EyeballError &&
        error.code === TOOL_ERROR_CODES.AUTH_MISSING &&
        token === MOCK_CREDENTIAL_TRIGGER_TOKENS.EXPIRED_TOKEN
      ) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.AUTH_EXPIRED,
          message: "The Discord bot token has expired.",
          providerDetail: { toolkit: context.tool.toolkit, status: 401 },
          cause: error,
        });
      }
      throw error;
    }
  };
}

async function discordObject(
  context: AdapterContext,
  client: ProviderHttpClient,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonObject(context, await client(path, init));
}

function discordMessage(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const author = isRecord(message.author) ? message.author : {};
  const memberId = requiredStringField(context, author, "id");
  const handle = stringValue(author, "username");
  const displayName = stringValue(author, "global_name") || handle || memberId;
  const reference = isRecord(message.message_reference)
    ? message.message_reference
    : undefined;
  const replyToMessageId =
    reference === undefined ? undefined : stringValue(reference, "message_id");
  const reactions = records(message.reactions).flatMap((reaction) => {
    const emoji = isRecord(reaction.emoji) ? reaction.emoji : {};
    const name = stringValue(emoji, "name") ?? stringValue(emoji, "id");
    if (name === undefined || name.length === 0) {
      return [];
    }
    return [
      {
        reaction: name,
        count: numberValue(reaction, "count") ?? 0,
        ...(typeof reaction.me === "boolean"
          ? { reactedByConnection: reaction.me }
          : {}),
      },
    ];
  });
  return {
    messageId: requiredStringField(context, message, "id"),
    conversationId: requiredStringField(context, message, "channel_id"),
    sender: {
      memberId,
      displayName,
      ...(handle === undefined || handle.length === 0 ? {} : { handle }),
      isBot: author.bot === true,
    },
    text: stringValue(message, "content") ?? "",
    sentAt: isoString(context, message.timestamp, "timestamp"),
    ...(typeof message.edited_timestamp === "string"
      ? {
          editedAt: isoString(
            context,
            message.edited_timestamp,
            "edited_timestamp",
          ),
        }
      : {}),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    reactions,
  };
}

function permissionDenied(value: unknown, permission: bigint): boolean {
  if (typeof value !== "string" && typeof value !== "number") {
    return false;
  }
  try {
    return (BigInt(value) & permission) === permission;
  } catch {
    return false;
  }
}

function discordChannelType(
  channel: Readonly<Record<string, unknown>>,
): "public" | "private" | "direct" | "group" {
  const type = numberValue(channel, "type") ?? 0;
  if (type === 1) {
    return "direct";
  }
  if (type === 3) {
    return "group";
  }
  return records(channel.permission_overwrites).some((overwrite) =>
    permissionDenied(overwrite.deny, 1024n),
  )
    ? "private"
    : "public";
}

function discordChannel(
  context: AdapterContext,
  channel: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const topic = stringValue(channel, "topic");
  return {
    conversationId: requiredStringField(context, channel, "id"),
    name: stringValue(channel, "name") ?? "",
    type: discordChannelType(channel),
    ...(topic === undefined ? {} : { topic }),
    archived: false,
  };
}

function snowflakeCreatedAt(context: AdapterContext, id: string): string {
  let milliseconds: bigint;
  try {
    milliseconds = (BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
  } catch {
    throw providerError(
      context,
      "Discord returned an invalid channel snowflake.",
    );
  }
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.valueOf())) {
    throw providerError(
      context,
      "Discord returned an invalid channel snowflake.",
    );
  }
  return date.toISOString();
}

function localOffset(context: AdapterContext): number {
  const token = stringValue(context.canonicalInput, "pageToken");
  if (token === undefined) {
    return 0;
  }
  const offset = Number(token);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return invalidInput(context, "pageToken is not a valid Discord offset.");
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

export class DiscordAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "discord";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "discord.send_message":
        return this.sendMessage(context);
      case "discord.list_channels":
        return this.listChannels(context);
      case "discord.list_messages":
        return this.listMessages(context);
      case "discord.get_message":
        return this.getMessage(context);
      case "discord.reply_to_message":
        return this.replyToMessage(context);
      case "discord.add_reaction":
        return this.addReaction(context);
      case "discord.create_channel":
        return this.createChannel(context);
      case "discord.list_members":
        return this.listMembers(context);
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
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    return discordObject(
      context,
      discordClient(context),
      `api/v10/channels/${encodeURIComponent(conversationId)}/messages`,
      jsonRequest({
        content: requiredStringField(context, input, "text"),
        ...(parentMessageId === undefined
          ? {}
          : {
              message_reference: {
                message_id: parentMessageId,
                channel_id: conversationId,
                fail_if_not_exists: true,
              },
            }),
      }),
    );
  }

  private async sendMessage(context: AdapterContext): Promise<JsonValue> {
    const parentMessageId = stringValue(
      context.canonicalInput,
      "replyToMessageId",
    );
    const message = await this.createMessage(context, parentMessageId);
    return asJson({
      messageId: requiredStringField(context, message, "id"),
      conversationId: requiredStringField(context, message, "channel_id"),
      sentAt: isoString(context, message.timestamp, "timestamp"),
    });
  }

  private async listChannels(context: AdapterContext): Promise<JsonValue> {
    const workspaceId = requiredInputString(context, "workspaceId");
    const response = await discordClient(context)(
      `api/v10/guilds/${encodeURIComponent(workspaceId)}/channels`,
    );
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw providerError(context, "Discord returned an invalid channel list.");
    }
    const requestedTypes = new Set(
      stringArrayValue(context.canonicalInput, "types"),
    );
    const channels = value
      .filter(isRecord)
      .map((channel) => discordChannel(context, channel))
      .filter(
        (channel) =>
          requestedTypes.size === 0 || requestedTypes.has(String(channel.type)),
      );
    const offset = localOffset(context);
    const pageSize = numberValue(context.canonicalInput, "pageSize") ?? 50;
    const page = channels.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return asJson({
      channels: page,
      ...(nextOffset < channels.length
        ? { nextPageToken: String(nextOffset) }
        : {}),
    });
  }

  private async listMessages(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const pageSize = numberValue(input, "pageSize") ?? 50;
    const search = new URLSearchParams({ limit: String(pageSize) });
    const pageToken = stringValue(input, "pageToken");
    if (pageToken !== undefined) {
      search.set("before", pageToken);
    }
    const response = await discordClient(context)(
      `api/v10/channels/${encodeURIComponent(conversationId)}/messages?${search.toString()}`,
    );
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw providerError(context, "Discord returned an invalid message list.");
    }
    const rawMessages = value.filter(isRecord);
    const messages = rawMessages
      .map((message) => discordMessage(context, message))
      .filter((message) => matchesMessageFilters(input, message));
    const lastMessage = rawMessages.at(-1);
    const nextPageToken =
      rawMessages.length === pageSize && lastMessage !== undefined
        ? stringValue(lastMessage, "id")
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
    const message = await discordObject(
      context,
      discordClient(context),
      `api/v10/channels/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    );
    return asJson(discordMessage(context, message));
  }

  private async replyToMessage(context: AdapterContext): Promise<JsonValue> {
    const parentMessageId = requiredStringField(
      context,
      context.canonicalInput,
      "messageId",
    );
    const message = await this.createMessage(context, parentMessageId);
    return asJson({
      messageId: requiredStringField(context, message, "id"),
      conversationId: requiredStringField(context, message, "channel_id"),
      parentMessageId,
      sentAt: isoString(context, message.timestamp, "timestamp"),
    });
  }

  private async addReaction(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const messageId = requiredStringField(context, input, "messageId");
    const reaction = requiredStringField(context, input, "reaction");
    await discordClient(context)(
      `api/v10/channels/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reaction)}/@me`,
      { method: "PUT" },
    );
    return asJson({ messageId, reaction, added: true });
  }

  private async createChannel(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const workspaceId = requiredInputString(context, "workspaceId");
    const visibility =
      stringValue(input, "visibility") === "private" ? "private" : "public";
    const permissionOverwrites: Array<Readonly<Record<string, unknown>>> = [];
    if (visibility === "private") {
      permissionOverwrites.push({
        id: workspaceId,
        type: 0,
        deny: VIEW_CHANNEL_PERMISSION,
      });
    }
    for (const memberId of stringArrayValue(input, "memberIds")) {
      permissionOverwrites.push({
        id: memberId,
        type: 1,
        allow: VIEW_CHANNEL_PERMISSION,
      });
    }
    const topic = stringValue(input, "topic");
    const channel = await discordObject(
      context,
      discordClient(context),
      `api/v10/guilds/${encodeURIComponent(workspaceId)}/channels`,
      jsonRequest({
        name: requiredStringField(context, input, "name"),
        type: 0,
        ...(topic === undefined ? {} : { topic }),
        permission_overwrites: permissionOverwrites,
      }),
    );
    const conversationId = requiredStringField(context, channel, "id");
    return asJson({
      conversationId,
      name: requiredStringField(context, channel, "name"),
      visibility,
      createdAt: snowflakeCreatedAt(context, conversationId),
    });
  }

  private async listMembers(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const workspaceId = requiredInputString(context, "workspaceId");
    const pageSize = numberValue(input, "pageSize") ?? 100;
    const search = new URLSearchParams({ limit: String(pageSize) });
    const pageToken = stringValue(input, "pageToken");
    if (pageToken !== undefined) {
      search.set("after", pageToken);
    }
    const response = await discordClient(context)(
      `api/v10/guilds/${encodeURIComponent(workspaceId)}/members?${search.toString()}`,
    );
    const value: unknown = await response.json();
    if (!Array.isArray(value)) {
      throw providerError(context, "Discord returned an invalid member list.");
    }
    const rawMembers = value.filter(isRecord);
    const members = rawMembers.map((member) => {
      const user = isRecord(member.user) ? member.user : {};
      const memberId = requiredStringField(context, user, "id");
      const handle = stringValue(user, "username");
      const role = stringArrayValue(member, "roles")[0];
      return {
        memberId,
        displayName:
          stringValue(member, "nick") ||
          stringValue(user, "global_name") ||
          handle ||
          memberId,
        ...(handle === undefined || handle.length === 0 ? {} : { handle }),
        ...(role === undefined ? {} : { role }),
        isBot: user.bot === true,
        status: member.pending === true ? "pending" : "active",
      };
    });
    const lastMember = rawMembers.at(-1);
    const nextPageToken =
      rawMembers.length === pageSize && lastMember !== undefined
        ? stringValue(isRecord(lastMember.user) ? lastMember.user : {}, "id")
        : undefined;
    return asJson({
      members,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }
}

export const discordAdapter = new DiscordAdapter();
