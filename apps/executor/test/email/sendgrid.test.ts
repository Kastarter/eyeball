import { beforeAll, describe, expect, it } from "vitest";
import type { SendGridStoredMessage } from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type EmailMocksModule =
  typeof import("../../../../mocks/packages/mocks-email/dist/index.js");
type EmailHelpersModule = typeof import("./helpers.js");

let createSendGridMock: EmailMocksModule["createSendGridMock"];
let createEmailMockHarness: EmailHelpersModule["createEmailMockHarness"];
let executionOutput: EmailHelpersModule["executionOutput"];
let storeRecords: EmailHelpersModule["storeRecords"];
const mocksAvailable = hasMocksCheckout();

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("SendGrid email adapter", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<EmailMocksModule>("mocks-email"),
        import("./helpers.js") as Promise<EmailHelpersModule>,
      ]);
      ({ createSendGridMock } = mocks);
      ({ createEmailMockHarness, executionOutput, storeRecords } = helpers);
    });

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
      expect(storeRecords<SendGridStoredMessage>(provider, "messages")).toEqual(
        [
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
        ],
      );
    });
  },
);
