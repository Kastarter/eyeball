import { describe, expect, it } from "vitest";
import {
  createResendMock,
  type ResendStoredEmail,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createEmailMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

describe("Resend email adapter", () => {
  it("sends canonical recipient groups through the Emails API", async () => {
    const provider = createResendMock();
    const harness = createEmailMockHarness(provider, {
      type: "api_key",
      values: { apiKey: "fixture:valid" },
    });
    const sent = executionOutput(
      await harness.execute("resend.send_email", {
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        subject: "Resend integration delivery",
        body: "The Resend mock accepted this message.",
        replyTo: "replies@example.com",
        x_provider: { resend: { from: "sender@example.com" } },
      }),
    );
    expect(sent).toEqual({
      messageId: "resend_email_000001",
      acceptedRecipients: ["recipient@example.com", "copy@example.com"],
    });
    expect(storeRecords<ResendStoredEmail>(provider, "emails")).toEqual([
      expect.objectContaining({
        id: "resend_email_000001",
        from: "sender@example.com",
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        replyTo: ["replies@example.com"],
        subject: "Resend integration delivery",
        text: "The Resend mock accepted this message.",
      }),
    ]);
  });
});
