import { describe, expect, it } from "vitest";
import {
  createSmtpMock,
  type SmtpSentMessage,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createEmailMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

function smtpHarness() {
  const provider = createSmtpMock();
  return {
    provider,
    harness: createEmailMockHarness(provider, {
      type: "basic",
      username: "fixture-user",
      password: "fixture:valid",
    }),
  };
}

describe("SMTP email adapter", () => {
  it("sends through the authenticated mock transport facade", async () => {
    const { provider, harness } = smtpHarness();
    const sent = executionOutput(
      await harness.execute("smtp.send_email", {
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        subject: "SMTP integration delivery",
        body: "The HTTP facade captured this SMTP delivery.",
        x_provider: { smtp: { from: "sender@example.com" } },
      }),
    );
    expect(sent).toEqual({
      messageId: "smtp_message_000001",
      acceptedRecipients: ["recipient@example.com", "copy@example.com"],
    });
    expect(storeRecords<SmtpSentMessage>(provider, "sent")).toEqual([
      expect.objectContaining({
        id: "smtp_message_000001",
        from: "sender@example.com",
        to: ["recipient@example.com", "copy@example.com"],
        subject: "SMTP integration delivery",
        text: "The HTTP facade captured this SMTP delivery.",
      }),
    ]);
  });

  it("returns not_supported for mailbox tools omitted by the manifest", async () => {
    const { harness } = smtpHarness();
    const result = await harness.execute("smtp.list_emails", {});
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      error: { code: "not_supported", retryable: false },
      requestId: "req_email_mocks",
    });
  });
});
