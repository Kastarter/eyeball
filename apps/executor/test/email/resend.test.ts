import { beforeAll, describe, expect, it } from "vitest";
import type { ResendStoredEmail } from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type EmailMocksModule =
  typeof import("../../../../mocks/packages/mocks-email/dist/index.js");
type EmailHelpersModule = typeof import("./helpers.js");

let createResendMock: EmailMocksModule["createResendMock"];
let createEmailMockHarness: EmailHelpersModule["createEmailMockHarness"];
let executionOutput: EmailHelpersModule["executionOutput"];
let storeRecords: EmailHelpersModule["storeRecords"];
const mocksAvailable = hasMocksCheckout();

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("Resend email adapter", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<EmailMocksModule>("mocks-email"),
        import("./helpers.js") as Promise<EmailHelpersModule>,
      ]);
      ({ createResendMock } = mocks);
      ({ createEmailMockHarness, executionOutput, storeRecords } = helpers);
    });

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
  },
);
