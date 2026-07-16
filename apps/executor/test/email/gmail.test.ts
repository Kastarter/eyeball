import { describe, expect, it } from "vitest";
import {
  createGmailMock,
  type GmailDraft,
  type GmailMessage,
  gmailFixtures,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createEmailMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

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

describe("Gmail email adapter", () => {
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
});
