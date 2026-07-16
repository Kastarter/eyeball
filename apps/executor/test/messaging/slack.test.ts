import { describe, expect, it } from "vitest";
import {
  createSlackMock,
  type SlackChannel,
  type SlackMessage,
  type SlackReaction,
  slackFixtures,
} from "../../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  createMessagingMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

function slackHarness(
  provider = createSlackMock(),
  accessToken = "fixture:valid",
) {
  return {
    provider,
    harness: createMessagingMockHarness(provider, {
      type: "oauth2",
      accessToken,
      scopes: [
        "channels:history",
        "channels:manage",
        "channels:read",
        "chat:write",
        "reactions:write",
        "users:read",
        "users:read.email",
      ],
    }),
  };
}

describe("Slack messaging adapter", () => {
  it("sends, replies, reacts, reads, and discovers conversations and members", async () => {
    const provider = createSlackMock();
    await provider.seed(slackFixtures.default);
    const { harness } = slackHarness(provider);

    const channels = executionOutput(
      await harness.execute("slack.list_channels", { types: ["public"] }),
    );
    expect(channels).toMatchObject({
      channels: [
        {
          conversationId: "C_GENERAL",
          name: "general",
          type: "public",
          topic: "General fixture conversation",
          memberCount: 3,
          archived: false,
        },
      ],
    });

    const sent = executionOutput(
      await harness.execute("slack.send_message", {
        conversationId: "C_GENERAL",
        text: "The Slack mock received this canonical message.",
      }),
    );
    expect(sent).toMatchObject({
      messageId: expect.any(String),
      conversationId: "C_GENERAL",
      sentAt: "2026-01-01T00:00:00.000Z",
    });
    const sentMessageId = String(sent.messageId);

    const replied = executionOutput(
      await harness.execute("slack.reply_to_message", {
        conversationId: "C_GENERAL",
        messageId: sentMessageId,
        text: "The Slack mock received this canonical thread reply.",
      }),
    );
    expect(replied).toMatchObject({
      messageId: expect.any(String),
      conversationId: "C_GENERAL",
      parentMessageId: sentMessageId,
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      executionOutput(
        await harness.execute("slack.add_reaction", {
          conversationId: "C_GENERAL",
          messageId: sentMessageId,
          reaction: "white_check_mark",
        }),
      ),
    ).toEqual({
      messageId: sentMessageId,
      reaction: "white_check_mark",
      added: true,
    });

    const message = executionOutput(
      await harness.execute("slack.get_message", {
        conversationId: "C_GENERAL",
        messageId: sentMessageId,
      }),
    );
    expect(message).toMatchObject({
      messageId: sentMessageId,
      conversationId: "C_GENERAL",
      sender: {
        memberId: "U_BOT",
        displayName: "Eyeball Fixture Bot",
        isBot: true,
      },
      text: "The Slack mock received this canonical message.",
      threadId: sentMessageId,
      reactions: [{ reaction: "white_check_mark", count: 1 }],
    });

    const listed = executionOutput(
      await harness.execute("slack.list_messages", {
        conversationId: "C_GENERAL",
        includeThreadReplies: true,
      }),
    );
    expect(listed).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ messageId: sentMessageId }),
        expect.objectContaining({
          messageId: replied.messageId,
          replyToMessageId: sentMessageId,
        }),
      ]),
    });

    const members = executionOutput(
      await harness.execute("slack.list_members", {
        conversationId: "C_GENERAL",
      }),
    );
    expect(members).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          memberId: "U_BLAKE",
          displayName: "Blake Fixture",
          isBot: false,
        }),
        expect.objectContaining({ memberId: "U_BOT", isBot: true }),
      ]),
    });

    const created = executionOutput(
      await harness.execute("slack.create_channel", {
        name: "adapter-integration",
        visibility: "private",
      }),
    );
    expect(created).toMatchObject({
      conversationId: expect.any(String),
      name: "adapter-integration",
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(storeRecords<SlackMessage>(provider, "messages")).toHaveLength(3);
    expect(storeRecords<SlackReaction>(provider, "reactions")).toHaveLength(2);
    expect(storeRecords<SlackChannel>(provider, "channels")).toHaveLength(2);
  });

  it("normalizes Slack's HTTP-200 expired-token envelope", async () => {
    const { harness } = slackHarness(
      createSlackMock(),
      "fixture:EXPIRED_TOKEN",
    );
    const result = await harness.execute("slack.list_channels", {});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tool: "slack.list_channels",
      status: "failed",
      error: { code: "auth_expired", retryable: false },
    });
  });
});
