import { describe, expect, it } from "vitest";
import {
  createDiscordMock,
  type DiscordChannel,
  type DiscordMessage,
  type DiscordReaction,
  discordFixtures,
} from "../../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  createMessagingMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

const GUILD_ID = "100000000000000001";
const CHANNEL_ID = "100000000000000101";
const FIXTURE_MESSAGE_ID = "100000000000001001";

function discordHarness(
  provider = createDiscordMock(),
  apiKey = "fixture:valid",
) {
  return {
    provider,
    harness: createMessagingMockHarness(provider, {
      type: "api_key",
      values: { apiKey },
    }),
  };
}

describe("Discord messaging adapter", () => {
  it("executes the complete guild, message, reaction, and member route subset", async () => {
    const provider = createDiscordMock();
    await provider.seed(discordFixtures.default);
    const { harness } = discordHarness(provider);

    expect(
      executionOutput(
        await harness.execute("discord.list_channels", {
          workspaceId: GUILD_ID,
        }),
      ),
    ).toMatchObject({
      channels: [
        {
          conversationId: CHANNEL_ID,
          name: "general",
          type: "public",
          topic: "General fixture conversation",
          archived: false,
        },
      ],
    });

    const fixture = executionOutput(
      await harness.execute("discord.get_message", {
        conversationId: CHANNEL_ID,
        messageId: FIXTURE_MESSAGE_ID,
      }),
    );
    expect(fixture).toMatchObject({
      messageId: FIXTURE_MESSAGE_ID,
      conversationId: CHANNEL_ID,
      sender: {
        memberId: "100000000000000002",
        displayName: "Blake Fixture",
        handle: "blake.fixture",
        isBot: false,
      },
      reactions: [{ reaction: "eyes", count: 1, reactedByConnection: false }],
    });

    const sent = executionOutput(
      await harness.execute("discord.send_message", {
        conversationId: CHANNEL_ID,
        text: "The Discord mock received this canonical message.",
      }),
    );
    expect(sent).toMatchObject({
      messageId: expect.any(String),
      conversationId: CHANNEL_ID,
      sentAt: "2026-01-01T00:00:00.000Z",
    });
    const sentMessageId = String(sent.messageId);

    const replied = executionOutput(
      await harness.execute("discord.reply_to_message", {
        conversationId: CHANNEL_ID,
        messageId: sentMessageId,
        text: "The Discord mock received this canonical reply.",
      }),
    );
    expect(replied).toMatchObject({
      messageId: expect.any(String),
      conversationId: CHANNEL_ID,
      parentMessageId: sentMessageId,
    });

    expect(
      executionOutput(
        await harness.execute("discord.add_reaction", {
          conversationId: CHANNEL_ID,
          messageId: sentMessageId,
          reaction: "eyes",
        }),
      ),
    ).toEqual({ messageId: sentMessageId, reaction: "eyes", added: true });

    expect(
      executionOutput(
        await harness.execute("discord.list_messages", {
          conversationId: CHANNEL_ID,
          includeThreadReplies: true,
        }),
      ),
    ).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          messageId: sentMessageId,
          reactions: [
            { reaction: "eyes", count: 1, reactedByConnection: true },
          ],
        }),
        expect.objectContaining({
          messageId: replied.messageId,
          replyToMessageId: sentMessageId,
        }),
      ]),
    });

    expect(
      executionOutput(
        await harness.execute("discord.list_members", {
          workspaceId: GUILD_ID,
        }),
      ),
    ).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          memberId: "100000000000000002",
          displayName: "Blake Fixture",
          role: "fixture-member",
          isBot: false,
          status: "active",
        }),
        expect.objectContaining({
          memberId: "100000000000000003",
          isBot: true,
        }),
      ]),
    });

    const channel = executionOutput(
      await harness.execute("discord.create_channel", {
        workspaceId: GUILD_ID,
        name: "adapter-integration",
        visibility: "private",
        topic: "Created through the canonical adapter",
        memberIds: ["100000000000000004"],
      }),
    );
    expect(channel).toMatchObject({
      conversationId: expect.any(String),
      name: "adapter-integration",
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(storeRecords<DiscordMessage>(provider, "messages")).toHaveLength(3);
    expect(storeRecords<DiscordReaction>(provider, "reactions")).toHaveLength(
      2,
    );
    expect(storeRecords<DiscordChannel>(provider, "channels")).toHaveLength(2);
  });

  it("normalizes an expired bot token from Discord's generic 401 body", async () => {
    const { harness } = discordHarness(
      createDiscordMock(),
      "fixture:EXPIRED_TOKEN",
    );
    const result = await harness.execute("discord.list_channels", {
      workspaceId: GUILD_ID,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tool: "discord.list_channels",
      status: "failed",
      error: { code: "auth_expired", retryable: false },
    });
  });
});
