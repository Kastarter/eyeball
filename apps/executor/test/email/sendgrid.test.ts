import { describe, expect, it } from "vitest";
import {
  createSendGridMock,
  type SendGridStoredMessage,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createEmailMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

describe("SendGrid email adapter", () => {
  it("sends a canonical email through v3 mail send", async () => {
    const provider = createSendGridMock();
    const harness = createEmailMockHarness(provider, {
      type: "api_key",
      values: { apiKey: "fixture:valid" },
    });
    const sent = executionOutput(
      await harness.execute("sendgrid.send_email", {
        to: ["recipient@example.com"],
        bcc: ["audit@example.com"],
        subject: "SendGrid integration delivery",
        body: "<p>The SendGrid mock accepted this message.</p>",
        bodyFormat: "html",
        replyTo: "replies@example.com",
        x_provider: {
          sendgrid: {
            from: "sender@example.com",
            fromName: "Integration Sender",
          },
        },
      }),
    );
    expect(sent).toEqual({
      messageId: "sendgrid_message_000001",
      acceptedRecipients: ["recipient@example.com", "audit@example.com"],
    });
    expect(storeRecords<SendGridStoredMessage>(provider, "messages")).toEqual([
      expect.objectContaining({
        id: "sendgrid_message_000001",
        from: { email: "sender@example.com", name: "Integration Sender" },
        to: [{ email: "recipient@example.com" }],
        bcc: [{ email: "audit@example.com" }],
        subject: "SendGrid integration delivery",
        content: [
          {
            type: "text/html",
            value: "<p>The SendGrid mock accepted this message.</p>",
          },
        ],
      }),
    ]);
  });
});
