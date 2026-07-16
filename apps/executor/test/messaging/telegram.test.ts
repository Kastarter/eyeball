import { describe, expect, it } from "vitest";
import {
  createTelegramMock,
  type TelegramMessage,
  telegramFixtures,
} from "../../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  createMessagingMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

const CHAT_ID = "-1001555000001";

function telegramHarness(
  provider = createTelegramMock(),
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

describe("Telegram messaging adapter", () => {
  it("sends and replies while reading the retained Bot API update stream", async () => {
    const provider = createTelegramMock();
    await provider.seed(telegramFixtures.default);
    const { harness } = telegramHarness(provider);

    expect(
      executionOutput(
        await harness.execute("telegram.get_message", {
          conversationId: CHAT_ID,
          messageId: "101",
        }),
      ),
    ).toMatchObject({
      messageId: "101",
      conversationId: CHAT_ID,
      sender: {
        memberId: "7000000002",
        displayName: "Blake Fixture",
        handle: "blake_fixture",
        isBot: false,
      },
      text: "Welcome to the deterministic Telegram fixture.",
      sentAt: "2025-12-31T23:59:00.000Z",
    });

    const sent = executionOutput(
      await harness.execute("telegram.send_message", {
        conversationId: CHAT_ID,
        text: "The Telegram mock received this canonical message.",
      }),
    );
    expect(sent).toEqual({
      messageId: "102",
      conversationId: CHAT_ID,
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    const reply = executionOutput(
      await harness.execute("telegram.reply_to_message", {
        conversationId: CHAT_ID,
        messageId: "102",
        text: "The Telegram mock received this canonical reply.",
      }),
    );
    expect(reply).toEqual({
      messageId: "103",
      conversationId: CHAT_ID,
      parentMessageId: "102",
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      executionOutput(
        await harness.execute("telegram.list_messages", {
          conversationId: CHAT_ID,
          includeThreadReplies: true,
        }),
      ),
    ).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ messageId: "101" }),
        expect.objectContaining({ messageId: "102" }),
        expect.objectContaining({
          messageId: "103",
          replyToMessageId: "102",
        }),
      ]),
    });
    expect(storeRecords<TelegramMessage>(provider, "messages")).toHaveLength(3);
  });

  it("normalizes an expired bot token from the shared auth fixture", async () => {
    const { harness } = telegramHarness(
      createTelegramMock(),
      "fixture:EXPIRED_TOKEN",
    );
    const result = await harness.execute("telegram.list_messages", {
      conversationId: CHAT_ID,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tool: "telegram.list_messages",
      status: "failed",
      error: { code: "auth_expired", retryable: false },
    });
  });
});
