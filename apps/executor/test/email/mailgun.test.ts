import { beforeAll, describe, expect, it } from "vitest";
import type {
  MailgunStoredEvent,
  MailgunStoredMessage,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type EmailMocksModule =
  typeof import("../../../../mocks/packages/mocks-email/dist/index.js");
type EmailHelpersModule = typeof import("./helpers.js");

let createMailgunMock: EmailMocksModule["createMailgunMock"];
let createEmailMockHarness: EmailHelpersModule["createEmailMockHarness"];
let executionOutput: EmailHelpersModule["executionOutput"];
let storeRecords: EmailHelpersModule["storeRecords"];
const mocksAvailable = hasMocksCheckout();

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("Mailgun email adapter", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<EmailMocksModule>("mocks-email"),
        import("./helpers.js") as Promise<EmailHelpersModule>,
      ]);
      ({ createMailgunMock } = mocks);
      ({ createEmailMockHarness, executionOutput, storeRecords } = helpers);
    });

    it("sends mail and lists the resulting accepted event canonically", async () => {
      const provider = createMailgunMock();
      const harness = createEmailMockHarness(provider, {
        type: "api_key",
        values: { apiKey: "fixture:valid" },
      });
      const providerInput = {
        mailgun: {
          domain: "sandbox.example.com",
          from: "Integration Sender <sender@example.com>",
        },
      } as const;
      const sent = executionOutput(
        await harness.execute("mailgun.send_email", {
          to: ["recipient@example.com"],
          subject: "Mailgun integration delivery",
          body: "The Mailgun mock accepted this delivery.",
          x_provider: providerInput,
        }),
      );
      expect(sent).toEqual({
        messageId: "<mailgun_message_000001@sandbox.example.com>",
        acceptedRecipients: ["recipient@example.com"],
      });

      const listed = executionOutput(
        await harness.execute("mailgun.list_emails", {
          to: "recipient@example.com",
          subject: "integration",
          x_provider: {
            mailgun: { domain: "sandbox.example.com" },
          },
        }),
      );
      expect(listed).toEqual({
        emails: [
          {
            messageId: "<mailgun_message_000001@sandbox.example.com>",
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject: "Mailgun integration delivery",
            receivedAt: "2026-01-01T00:00:00.000Z",
            unread: false,
            hasAttachments: false,
            labelIds: ["accepted"],
          },
        ],
      });
      expect(
        storeRecords<MailgunStoredMessage>(provider, "messages"),
      ).toHaveLength(1);
      expect(storeRecords<MailgunStoredEvent>(provider, "events")).toHaveLength(
        1,
      );
    });
  },
);
