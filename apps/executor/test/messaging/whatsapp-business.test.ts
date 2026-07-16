import { describe, expect, it } from "vitest";
import {
  createWhatsAppBusinessMock,
  type WhatsAppMessage,
} from "../../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  createMessagingMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

const PHONE_NUMBER_ID = "15550001111";
const RECIPIENT_ID = "15550002222";

function whatsAppHarness(
  provider = createWhatsAppBusinessMock(),
  values: Readonly<Record<string, string>> = {
    apiKey: "fixture:valid",
    phoneNumberId: `fixture:${PHONE_NUMBER_ID}`,
  },
) {
  return {
    provider,
    harness: createMessagingMockHarness(provider, {
      type: "api_key",
      values,
    }),
  };
}

describe("WhatsApp Business messaging adapter", () => {
  it("sends through the configured phone number and reads the mock retrieval shim", async () => {
    const { provider, harness } = whatsAppHarness();
    const sent = executionOutput(
      await harness.execute("whatsapp-business.send_message", {
        conversationId: RECIPIENT_ID,
        text: "The WhatsApp mock received this canonical message.",
      }),
    );
    expect(sent).toEqual({
      messageId: "wamid.whatsapp_message_000001",
      conversationId: RECIPIENT_ID,
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    expect(
      executionOutput(
        await harness.execute("whatsapp-business.get_message", {
          conversationId: RECIPIENT_ID,
          messageId: "wamid.whatsapp_message_000001",
        }),
      ),
    ).toMatchObject({
      messageId: "wamid.whatsapp_message_000001",
      conversationId: RECIPIENT_ID,
      sender: {
        memberId: PHONE_NUMBER_ID,
        displayName: PHONE_NUMBER_ID,
        isBot: true,
      },
      text: "The WhatsApp mock received this canonical message.",
      sentAt: "2026-01-01T00:00:00.000Z",
    });

    expect(storeRecords<WhatsAppMessage>(provider, "messages")).toEqual([
      expect.objectContaining({
        id: "whatsapp_message_000001",
        messageId: "wamid.whatsapp_message_000001",
        phoneNumberId: PHONE_NUMBER_ID,
        to: RECIPIENT_ID,
        type: "text",
        text: "The WhatsApp mock received this canonical message.",
        status: "accepted",
      }),
    ]);
  });

  it("requires the phone number ID in the connection credential tuple", async () => {
    const { harness } = whatsAppHarness(createWhatsAppBusinessMock(), {
      apiKey: "fixture:valid",
    });
    const result = await harness.execute("whatsapp-business.send_message", {
      conversationId: RECIPIENT_ID,
      text: "This must not be sent without a phone number ID.",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      tool: "whatsapp-business.send_message",
      status: "failed",
      error: { code: "auth_missing", retryable: false },
    });
  });
});
