import { beforeAll, describe, expect, it } from "vitest";
import type {
  GmailDraft,
  GmailMessage,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type EmailMocksModule =
  typeof import("../../../../mocks/packages/mocks-email/dist/index.js");
type EmailHelpersModule = typeof import("./helpers.js");

let createGmailMock: EmailMocksModule["createGmailMock"];
let gmailFixtures: EmailMocksModule["gmailFixtures"];
let createEmailMockHarness: EmailHelpersModule["createEmailMockHarness"];
let executionOutput: EmailHelpersModule["executionOutput"];
let storeRecords: EmailHelpersModule["storeRecords"];
const mocksAvailable = hasMocksCheckout();

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

function gmailHarness(
  provider = createGmailMock(),
  accessToken = "fixture:valid",
) {
  return {
    provider,
    harness: createEmailMockHarness(provider, {
      type: "oauth2",
      accessToken,
      scopes: [GMAIL_SCOPE],
    }),
  };
}

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("Gmail email adapter", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<EmailMocksModule>("mocks-email"),
        import("./helpers.js") as Promise<EmailHelpersModule>,
      ]);
      ({ createGmailMock, gmailFixtures } = mocks);
      ({ createEmailMockHarness, executionOutput, storeRecords } = helpers);
    });

    it("sends base64url mail and lists the stored message canonically", async () => {
      const { provider, harness } = gmailHarness();
      const sent = executionOutput(
        await harness.execute("gmail.send_email", {
          to: ["recipient@example.com"],
          cc: ["copy@example.com"],
          subject: "Gmail integration delivery",
          body: "The Gmail mock received base64url RFC 5322 content.",
          x_provider: { gmail: { sendAs: "sender@example.com" } },
        }),
      );
      expect(sent).toMatchObject({
        messageId: "gmail_msg_000001",
        threadId: "gmail_thread_000001",
        acceptedRecipients: ["recipient@example.com", "copy@example.com"],
      });

      const listed = executionOutput(
        await harness.execute("gmail.list_emails", {
          subject: "Gmail integration delivery",
        }),
      );
      expect(listed).toMatchObject({
        emails: [
          {
            messageId: "gmail_msg_000001",
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject: "Gmail integration delivery",
            unread: false,
            hasAttachments: false,
            labelIds: ["SENT"],
          },
        ],
      });
      const messages = storeRecords<GmailMessage>(provider, "messages");
      expect(messages).toHaveLength(1);
      expect(
        Buffer.from(messages[0]?.raw ?? "", "base64url").toString("utf8"),
      ).toContain("Subject: Gmail integration delivery\r\n");
    });

    it("sends and drafts staged files as base64url MIME multipart attachments", async () => {
      const { provider, harness } = gmailHarness();
      const attachment = await harness.stageFile({
        name: "invoice.pdf",
        mimeType: "application/pdf",
        content: Uint8Array.from([0, 1, 2, 255]),
      });

      executionOutput(
        await harness.execute("gmail.send_email", {
          to: ["recipient@example.com"],
          subject: "Attached invoice",
          body: "Please see the attachment.",
          attachments: [attachment],
        }),
      );
      const sentMessage = storeRecords<GmailMessage>(provider, "messages").find(
        ({ labelIds }) => labelIds.includes("SENT"),
      );
      const sentRaw = Buffer.from(sentMessage?.raw ?? "", "base64url").toString(
        "utf8",
      );
      expect(sentRaw).toContain("Content-Type: multipart/mixed;");
      expect(sentRaw).toContain("Content-Type: application/pdf");
      expect(sentRaw).toContain('filename="invoice.pdf"');
      expect(sentRaw).toContain("AAEC/w==");

      const draft = executionOutput(
        await harness.execute("gmail.create_draft", {
          to: ["reviewer@example.com"],
          subject: "Review invoice",
          body: "Check the attachment before sending.",
          attachments: [attachment],
        }),
      );
      const draftRecord = storeRecords<GmailDraft>(provider, "drafts").find(
        ({ id }) => id === draft.draftId,
      );
      const draftMessage = storeRecords<GmailMessage>(
        provider,
        "messages",
      ).find(({ id }) => id === draftRecord?.messageId);
      const draftRaw = Buffer.from(
        draftMessage?.raw ?? "",
        "base64url",
      ).toString("utf8");
      expect(draftRaw).toContain('filename="invoice.pdf"');
      expect(draftRaw).toContain("Content-Transfer-Encoding: base64");

      const beforeReply = harness.providerRequests().length;
      const unsupportedReply = await harness.execute("gmail.reply_to_email", {
        messageId: "gmail_msg_000001",
        body: "This path must fail before provider I/O.",
        attachments: [attachment],
      });
      expect(unsupportedReply.body).toMatchObject({
        status: "failed",
        error: {
          code: "not_supported",
          message: expect.stringContaining(
            "does not support staged attachments",
          ),
        },
      });
      expect(harness.providerRequests()).toHaveLength(beforeReply);
    });

    it("gets, replies, labels, searches, drafts, and lists threads", async () => {
      const provider = createGmailMock();
      await provider.seed(gmailFixtures.default);
      const { harness } = gmailHarness(provider);

      const email = executionOutput(
        await harness.execute("gmail.get_email", {
          messageId: "msg_default_000001",
        }),
      );
      expect(email).toMatchObject({
        messageId: "msg_default_000001",
        threadId: "thread_default_000001",
        body: { format: "text", content: "Your January invoice is ready." },
        draft: false,
      });

      const reply = executionOutput(
        await harness.execute("gmail.reply_to_email", {
          messageId: "msg_default_000001",
          body: "Thanks, the invoice is approved.",
        }),
      );
      expect(reply).toMatchObject({
        threadId: "thread_default_000001",
        acceptedRecipients: ["billing@acme.example"],
      });

      const labeled = executionOutput(
        await harness.execute("gmail.add_email_label", {
          messageId: "msg_default_000002",
          labelId: "UNREAD",
        }),
      );
      expect(labeled).toEqual({
        messageId: "msg_default_000002",
        labelId: "UNREAD",
        applied: true,
      });
      expect(
        storeRecords<GmailMessage>(provider, "messages").find(
          ({ id }) => id === "msg_default_000002",
        )?.labelIds,
      ).toContain("UNREAD");

      const searched = executionOutput(
        await harness.execute("gmail.search_emails", {
          query: "subject:invoice",
        }),
      );
      expect(searched).toMatchObject({
        emails: expect.arrayContaining([
          expect.objectContaining({ messageId: "msg_default_000001" }),
        ]),
      });

      const draft = executionOutput(
        await harness.execute("gmail.create_draft", {
          to: ["reviewer@example.com"],
          subject: "Draft for review",
          body: "Please review before sending.",
        }),
      );
      expect(draft).toMatchObject({
        draftId: "gmail_draft_000001",
        messageId: expect.any(String),
      });
      expect(storeRecords<GmailDraft>(provider, "drafts")).toHaveLength(1);

      const threads = executionOutput(
        await harness.execute("gmail.list_threads", { labelIds: ["INBOX"] }),
      );
      expect(threads).toMatchObject({
        threads: expect.arrayContaining([
          expect.objectContaining({
            threadId: "thread_default_000001",
            messageCount: 2,
          }),
        ]),
      });
    });

    it("normalizes the real mock EXPIRED_TOKEN response to auth_expired", async () => {
      const { harness } = gmailHarness(
        createGmailMock(),
        "fixture:EXPIRED_TOKEN",
      );
      const result = await harness.execute("gmail.list_emails", {});
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        tool: "gmail.list_emails",
        status: "failed",
        error: { code: "auth_expired", retryable: false },
      });
    });
  },
);
