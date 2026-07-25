import { type Context, Hono } from "hono";
import {
  type AuthFailure,
  createMockClock,
  createStore,
  cursorPage,
  defineProviderMock,
  isObject,
  type JsonValue,
  type MockClock,
  type ProviderMock,
  readJsonObject,
  requiredString,
  type SeedRecord,
  type StoredRecord,
  validIso,
} from "../kit/index.js";

export interface SlackChannel {
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  topic: string;
  creator: string;
  memberIds: string[];
  createdAt: string;
}

export interface SlackUser {
  handle: string;
  displayName: string;
  realName: string;
  email: string;
  isBot: boolean;
}

export interface SlackMessage {
  channelId: string;
  userId: string;
  text: string;
  ts: string;
  threadTs?: string;
  createdAt: string;
}

export interface SlackReaction {
  channelId: string;
  messageTs: string;
  name: string;
  userId: string;
}

export interface CreateSlackMockOptions {
  clock?: MockClock;
}

export const SLACK_ROUTE_COUNT = 8;

const BOT_USER_ID = "U_FIXTURE_BOT";

const defaultSlackUsers = [
  {
    id: "U_FIXTURE_USER_ONE",
    handle: "fixture.user.one",
    displayName: "Fixture User One",
    realName: "Fixture User One",
    email: "fixture.user.one@example.com",
    isBot: false,
  },
  {
    id: "U_FIXTURE_USER_TWO",
    handle: "fixture.user.two",
    displayName: "Fixture User Two",
    realName: "Fixture User Two",
    email: "fixture.user.two@example.com",
    isBot: false,
  },
  {
    id: BOT_USER_ID,
    handle: "fixture.bot",
    displayName: "Fixture Bot",
    realName: "Fixture Bot",
    email: "fixture.bot@example.com",
    isBot: true,
  },
] as const;

const defaultSlackChannels = [
  {
    id: "C_GENERAL",
    name: "general",
    isPrivate: false,
    isArchived: false,
    topic: "General deterministic fixture conversation",
    creator: "U_FIXTURE_USER_ONE",
    memberIds: ["U_FIXTURE_USER_ONE", "U_FIXTURE_USER_TWO", BOT_USER_ID],
    createdAt: "2025-12-31T23:00:00.000Z",
  },
] as const;

export const slackFixtures = {
  default: {
    users: defaultSlackUsers,
    channels: defaultSlackChannels,
    messages: [
      {
        id: "slack_message_default_000001",
        channelId: "C_GENERAL",
        userId: "U_FIXTURE_USER_ONE",
        text: "Welcome to the deterministic Slack fixture.",
        ts: "1767225540.000001",
        createdAt: "2025-12-31T23:59:00.000Z",
      },
    ],
    reactions: [
      {
        id: "slack_reaction_default_000001",
        channelId: "C_GENERAL",
        messageTs: "1767225540.000001",
        name: "eyes",
        userId: "U_FIXTURE_USER_TWO",
      },
    ],
  },
} as const;

function slackAuthCode(failure: AuthFailure): string {
  if (failure.kind === "insufficient_scope") {
    return "missing_scope";
  }
  if (failure.kind === "rate_limited") {
    return "ratelimited";
  }
  return "invalid_auth";
}

function formatSlackAuthError(failure: AuthFailure): JsonValue {
  return { ok: false, error: slackAuthCode(failure) };
}

function slackError(context: Context, error: string): Response {
  return context.json({ ok: false, error }, 200);
}

function apiChannel(channel: StoredRecord<SlackChannel>) {
  return {
    id: channel.id,
    name: channel.name,
    is_channel: true,
    is_private: channel.isPrivate,
    is_archived: channel.isArchived,
    created: Math.floor(new Date(channel.createdAt).getTime() / 1_000),
    creator: channel.creator,
    topic: {
      value: channel.topic,
      creator: channel.creator,
      last_set: Math.floor(new Date(channel.createdAt).getTime() / 1_000),
    },
    num_members: channel.memberIds.length,
  };
}

function apiUser(user: StoredRecord<SlackUser>) {
  return {
    id: user.id,
    team_id: "T_FIXTURE",
    name: user.handle,
    deleted: false,
    real_name: user.realName,
    is_bot: user.isBot,
    profile: {
      display_name: user.displayName,
      real_name: user.realName,
      email: user.email,
    },
  };
}

function seedSystemStores(
  channels: ReturnType<typeof createStore<SlackChannel>>,
  users: ReturnType<typeof createStore<SlackUser>>,
): void {
  channels.seed(
    defaultSlackChannels.map((channel) => ({
      ...channel,
      memberIds: [...channel.memberIds],
    })),
  );
  users.seed(defaultSlackUsers.map((user) => ({ ...user })));
}

function slackTimestamp(clock: MockClock, sequence: number): string {
  const seconds = Math.floor(clock.now().getTime() / 1_000);
  return `${seconds}.${String(sequence).padStart(6, "0")}`;
}

function parseSeedChannel(value: unknown): SeedRecord<SlackChannel> {
  if (!isObject(value)) {
    throw new Error("Slack seed channels must be objects.");
  }
  if (
    !Array.isArray(value.memberIds) ||
    value.memberIds.some((item) => typeof item !== "string")
  ) {
    throw new Error("Slack seed channel memberIds must be strings.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    name: requiredString(value.name, "channels[].name"),
    isPrivate: value.isPrivate === true,
    isArchived: value.isArchived === true,
    topic: typeof value.topic === "string" ? value.topic : "",
    creator: requiredString(value.creator, "channels[].creator"),
    memberIds: [...new Set(value.memberIds as string[])],
    createdAt: validIso(value.createdAt, "channels[].createdAt"),
  };
}

function parseSeedUser(value: unknown): SeedRecord<SlackUser> {
  if (!isObject(value)) {
    throw new Error("Slack seed users must be objects.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    handle: requiredString(value.handle, "users[].handle"),
    displayName: requiredString(value.displayName, "users[].displayName"),
    realName: requiredString(value.realName, "users[].realName"),
    email: requiredString(value.email, "users[].email"),
    isBot: value.isBot === true,
  };
}

function parseSeedMessage(value: unknown): SeedRecord<SlackMessage> {
  if (!isObject(value)) {
    throw new Error("Slack seed messages must be objects.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    channelId: requiredString(value.channelId, "messages[].channelId"),
    userId: requiredString(value.userId, "messages[].userId"),
    text: requiredString(value.text, "messages[].text"),
    ts: requiredString(value.ts, "messages[].ts"),
    ...(typeof value.threadTs === "string" ? { threadTs: value.threadTs } : {}),
    createdAt: validIso(value.createdAt, "messages[].createdAt"),
  };
}

function parseSeedReaction(value: unknown): SeedRecord<SlackReaction> {
  if (!isObject(value)) {
    throw new Error("Slack seed reactions must be objects.");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    channelId: requiredString(value.channelId, "reactions[].channelId"),
    messageTs: requiredString(value.messageTs, "reactions[].messageTs"),
    name: requiredString(value.name, "reactions[].name"),
    userId: requiredString(value.userId, "reactions[].userId"),
  };
}

/** Creates the Slack Web API mock under `/api`. */
export function createSlackMock(
  options: CreateSlackMockOptions = {},
): ProviderMock {
  const clock = options.clock ?? createMockClock();
  const channels = createStore<SlackChannel>("slack_channel");
  const users = createStore<SlackUser>("slack_user");
  const messages = createStore<SlackMessage>("slack_message");
  const reactions = createStore<SlackReaction>("slack_reaction");
  seedSystemStores(channels, users);
  const app = new Hono();

  function findMessage(
    channelId: string,
    ts: string,
  ): StoredRecord<SlackMessage> | undefined {
    return messages
      .list()
      .find((message) => message.channelId === channelId && message.ts === ts);
  }

  function apiMessage(message: StoredRecord<SlackMessage>) {
    const grouped = new Map<string, string[]>();
    for (const reaction of reactions
      .list()
      .filter(
        (item) =>
          item.channelId === message.channelId && item.messageTs === message.ts,
      )) {
      const usersForReaction = grouped.get(reaction.name) ?? [];
      usersForReaction.push(reaction.userId);
      grouped.set(reaction.name, usersForReaction);
    }
    const replyCount = messages
      .list()
      .filter(
        (candidate) =>
          candidate.channelId === message.channelId &&
          candidate.threadTs === message.ts,
      ).length;
    return {
      type: "message",
      user: message.userId,
      text: message.text,
      ts: message.ts,
      ...(message.threadTs === undefined
        ? replyCount === 0
          ? {}
          : { reply_count: replyCount }
        : { thread_ts: message.threadTs }),
      ...(grouped.size === 0
        ? {}
        : {
            reactions: [...grouped.entries()].map(([name, memberIds]) => ({
              name,
              users: memberIds,
              count: memberIds.length,
            })),
          }),
    };
  }

  app.post("/api/chat.postMessage", async (context) => {
    let body: Record<string, unknown>;
    let channelId: string;
    let text: string;
    let threadTs: string | undefined;
    try {
      body = await readJsonObject(context);
      channelId = requiredString(body.channel, "channel");
      text = requiredString(body.text, "text");
      threadTs =
        body.thread_ts === undefined
          ? undefined
          : requiredString(body.thread_ts, "thread_ts");
    } catch {
      return slackError(context, "invalid_arguments");
    }
    if (channels.get(channelId) === undefined) {
      return slackError(context, "channel_not_found");
    }
    if (
      threadTs !== undefined &&
      findMessage(channelId, threadTs) === undefined
    ) {
      return slackError(context, "thread_not_found");
    }
    const message = messages.create({
      channelId,
      userId: BOT_USER_ID,
      text,
      ts: slackTimestamp(clock, messages.size + 1),
      ...(threadTs === undefined ? {} : { threadTs }),
      createdAt: clock.nowIso(),
    });
    return context.json({
      ok: true,
      channel: channelId,
      ts: message.ts,
      message: apiMessage(message),
    });
  });

  app.get("/api/conversations.list", (context) => {
    const url = new URL(context.req.url);
    const includeArchived =
      url.searchParams.get("exclude_archived") === "false";
    try {
      const page = cursorPage({
        items: channels
          .list()
          .filter((channel) => includeArchived || !channel.isArchived),
        scope: "slack-channels",
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      });
      return context.json({
        ok: true,
        channels: page.items.map(apiChannel),
        response_metadata: { next_cursor: page.nextCursor },
      });
    } catch {
      return slackError(context, "invalid_arguments");
    }
  });

  app.get("/api/conversations.history", (context) => {
    const url = new URL(context.req.url);
    const channelId = url.searchParams.get("channel");
    if (channelId === null || channels.get(channelId) === undefined) {
      return slackError(context, "channel_not_found");
    }
    const oldest = url.searchParams.get("oldest");
    const latest = url.searchParams.get("latest");
    const inclusive = url.searchParams.get("inclusive") === "true";
    let candidates = messages
      .list()
      .filter(
        (message) =>
          message.channelId === channelId && message.threadTs === undefined,
      )
      .filter((message) => {
        const ts = Number(message.ts);
        return (
          (oldest === null ||
            (inclusive ? ts >= Number(oldest) : ts > Number(oldest))) &&
          (latest === null ||
            (inclusive ? ts <= Number(latest) : ts < Number(latest)))
        );
      })
      .sort((left, right) => Number(right.ts) - Number(left.ts));
    try {
      const page = cursorPage({
        items: candidates,
        scope: `slack-history:${channelId}`,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      });
      candidates = page.items;
      return context.json({
        ok: true,
        messages: candidates.map(apiMessage),
        has_more: page.nextCursor.length > 0,
        response_metadata: { next_cursor: page.nextCursor },
      });
    } catch {
      return slackError(context, "invalid_arguments");
    }
  });

  app.get("/api/conversations.replies", (context) => {
    const url = new URL(context.req.url);
    const channelId = url.searchParams.get("channel");
    const ts = url.searchParams.get("ts");
    if (channelId === null || channels.get(channelId) === undefined) {
      return slackError(context, "channel_not_found");
    }
    if (ts === null) {
      return slackError(context, "invalid_arguments");
    }
    const root = findMessage(channelId, ts);
    if (root === undefined) {
      return slackError(context, "message_not_found");
    }
    const threadTs = root.threadTs ?? root.ts;
    const thread = messages
      .list()
      .filter(
        (message) =>
          message.channelId === channelId &&
          (message.ts === threadTs || message.threadTs === threadTs),
      )
      .sort((left, right) => Number(left.ts) - Number(right.ts));
    try {
      const page = cursorPage({
        items: thread,
        scope: `slack-replies:${channelId}:${threadTs}`,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      });
      return context.json({
        ok: true,
        messages: page.items.map(apiMessage),
        has_more: page.nextCursor.length > 0,
        response_metadata: { next_cursor: page.nextCursor },
      });
    } catch {
      return slackError(context, "invalid_arguments");
    }
  });

  app.post("/api/conversations.create", async (context) => {
    let body: Record<string, unknown>;
    let name: string;
    try {
      body = await readJsonObject(context);
      name = requiredString(body.name, "name");
      if (!/^[a-z0-9_-]{1,80}$/u.test(name)) {
        throw new Error("invalid channel name");
      }
    } catch {
      return slackError(context, "invalid_name");
    }
    if (channels.list().some((channel) => channel.name === name)) {
      return slackError(context, "name_taken");
    }
    const channel = channels.create({
      name,
      isPrivate: body.is_private === true,
      isArchived: false,
      topic: "",
      creator: BOT_USER_ID,
      memberIds: [BOT_USER_ID],
      createdAt: clock.nowIso(),
    });
    return context.json({ ok: true, channel: apiChannel(channel) });
  });

  app.get("/api/conversations.members", (context) => {
    const url = new URL(context.req.url);
    const channelId = url.searchParams.get("channel");
    const channel = channelId === null ? undefined : channels.get(channelId);
    if (channel === undefined) {
      return slackError(context, "channel_not_found");
    }
    try {
      const page = cursorPage({
        items: channel.memberIds,
        scope: `slack-members:${channel.id}`,
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      });
      return context.json({
        ok: true,
        members: page.items,
        response_metadata: { next_cursor: page.nextCursor },
      });
    } catch {
      return slackError(context, "invalid_arguments");
    }
  });

  app.post("/api/reactions.add", async (context) => {
    let channelId: string;
    let timestamp: string;
    let name: string;
    try {
      const body = await readJsonObject(context);
      channelId = requiredString(body.channel, "channel");
      timestamp = requiredString(body.timestamp, "timestamp");
      name = requiredString(body.name, "name");
    } catch {
      return slackError(context, "invalid_arguments");
    }
    if (channels.get(channelId) === undefined) {
      return slackError(context, "channel_not_found");
    }
    if (findMessage(channelId, timestamp) === undefined) {
      return slackError(context, "message_not_found");
    }
    const exists = reactions
      .list()
      .some(
        (reaction) =>
          reaction.channelId === channelId &&
          reaction.messageTs === timestamp &&
          reaction.name === name &&
          reaction.userId === BOT_USER_ID,
      );
    if (!exists) {
      reactions.create({
        channelId,
        messageTs: timestamp,
        name,
        userId: BOT_USER_ID,
      });
    }
    return context.json({ ok: true });
  });

  app.get("/api/users.list", (context) => {
    const url = new URL(context.req.url);
    try {
      const page = cursorPage({
        items: users.list(),
        scope: "slack-users",
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      });
      return context.json({
        ok: true,
        members: page.items.map(apiUser),
        response_metadata: { next_cursor: page.nextCursor },
      });
    } catch {
      return slackError(context, "invalid_arguments");
    }
  });

  const provider = defineProviderMock({
    slug: "slack",
    app,
    clock,
    stores: { channels, users, messages, reactions },
    formatErrors: formatSlackAuthError,
    reset() {
      seedSystemStores(channels, users);
    },
    seed(data, stores) {
      if (!isObject(data) || !Array.isArray(data.messages)) {
        throw new Error("Slack seed data must contain a messages array.");
      }
      const channelValues = data.channels ?? defaultSlackChannels;
      const userValues = data.users ?? defaultSlackUsers;
      const reactionValues = data.reactions ?? [];
      if (
        !Array.isArray(channelValues) ||
        !Array.isArray(userValues) ||
        !Array.isArray(reactionValues)
      ) {
        throw new Error(
          "Slack seed channels, users, and reactions must be arrays.",
        );
      }
      stores.channels.seed(channelValues.map(parseSeedChannel));
      stores.users.seed(userValues.map(parseSeedUser));
      const seededMessages = stores.messages.seed(
        data.messages.map(parseSeedMessage),
      );
      for (const message of seededMessages) {
        if (
          stores.channels.get(message.channelId) === undefined ||
          stores.users.get(message.userId) === undefined
        ) {
          throw new Error(
            "Slack seed messages require known channels and users.",
          );
        }
      }
      const seededReactions = stores.reactions.seed(
        reactionValues.map(parseSeedReaction),
      );
      for (const reaction of seededReactions) {
        if (
          findMessage(reaction.channelId, reaction.messageTs) === undefined ||
          stores.users.get(reaction.userId) === undefined
        ) {
          throw new Error(
            "Slack seed reactions require known messages and users.",
          );
        }
      }
    },
    seedBundles: slackFixtures,
  });

  // Slack's Web API reports auth failures as HTTP 200 with `ok: false`.
  const slackApp = new Hono();
  slackApp.use("*", async (context, next) => {
    await next();
    if (context.res.status !== 200 && context.res.headers.has("x-request-id")) {
      context.res = new Response(context.res.body, {
        status: 200,
        headers: context.res.headers,
      });
    }
  });
  slackApp.route("/", provider.app);

  return { ...provider, app: slackApp };
}
