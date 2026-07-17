import { describe, expect, it } from "vitest";
import {
  createMicrosoftOutlookMock,
  microsoftOutlookFixtures,
  type OutlookDraft,
  type OutlookMessage,
} from "../../../../mocks/packages/mocks-email/dist/index.js";
import {
  createEmailMockHarness,
  executionOutput,
  storeRecords,
} from "./helpers.js";

const OUTLOOK_SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
] as const;

function outlookHarness(provider = createMicrosoftOutlookMock()) {
  return {
    provider,
    harness: createEmailMockHarness(provider, {
      type: "oauth2",
      accessToken: "fixture:valid",
      scopes: OUTLOOK_SCOPES,
    }),
  };
}

describe("Microsoft Outlook email adapter", () => {
  it("sends with Graph sendMail and lists the stored sent message", async () => {
    const { provider, harness } = outlookHarness();
    const sent = executionOutput(
      await harness.execute("microsoft-outlook.send_email", {
        to: ["recipient@example.com"],
        cc: ["copy@example.com"],
        subject: "Outlook integration delivery",
        body: "The Graph mock accepted this sendMail request.",
      }),
    );
    expect(sent).toMatchObject({
      messageId: "outlook_msg_000001",
      threadId: "outlook_thread_000001",
      acceptedRecipients: ["recipient@example.com", "copy@example.com"],
    });

    const listed = executionOutput(
      await harness.execute("microsoft-outlook.list_emails", {
        subject: "Outlook integration delivery",
      }),
    );
    expect(listed).toMatchObject({
      emails: [
        {
          messageId: "outlook_msg_000001",
          from: "avery@acme.example",
          to: ["recipient@example.com"],
          subject: "Outlook integration delivery",
          unread: false,
          hasAttachments: false,
          labelIds: ["sentitems"],
        },
      ],
    });
    expect(storeRecords<OutlookMessage>(provider, "messages")).toHaveLength(1);
  });

  it("maps a staged file to a Graph send attachment", async () => {
    const provider = createMicrosoftOutlookMock();
    await provider.seed(microsoftOutlookFixtures.default);
    const { harness } = outlookHarness(provider);
    const attachment = await harness.stageFile({
      name: "notes.txt",
      mimeType: "text/plain",
      content: "hello outlook",
    });
    executionOutput(
      await harness.execute("microsoft-outlook.send_email", {
        to: ["recipient@example.com"],
        subject: "Outlook attachment",
        body: "The file is attached.",
        attachments: [attachment],
      }),
    );
    const expected = {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "notes.txt",
      contentType: "text/plain",
      contentBytes: Buffer.from("hello outlook", "utf8").toString("base64"),
    };
    const requests = harness.providerRequests();
    const sendRequest = requests.find((request) =>
      request.url.endsWith("/v1.0/me/sendMail"),
    );
    expect(JSON.parse(sendRequest?.body ?? "{}")).toMatchObject({
      message: { attachments: [expected] },
    });

    const beforeUnsupported = harness.providerRequests().length;
    for (const [tool, input] of [
      [
        "microsoft-outlook.reply_to_email",
        {
          messageId: "outlook_msg_default_000001",
          body: "This path must fail before provider I/O.",
          attachments: [attachment],
        },
      ],
      [
        "microsoft-outlook.create_draft",
        {
          body: "This path must fail before provider I/O.",
          attachments: [attachment],
        },
      ],
    ] as const) {
      const unsupported = await harness.execute(tool, input);
      expect(unsupported.body).toMatchObject({
        status: "failed",
        error: {
          code: "not_supported",
          message: expect.stringContaining(
            "does not support staged attachments",
          ),
        },
      });
    }
    expect(harness.providerRequests()).toHaveLength(beforeUnsupported);
  });

  it("gets, searches with $search, replies, drafts, groups threads, and resolves folders", async () => {
    const provider = createMicrosoftOutlookMock();
    await provider.seed(microsoftOutlookFixtures.default);
    const { harness } = outlookHarness(provider);

    const email = executionOutput(
      await harness.execute("microsoft-outlook.get_email", {
        messageId: "outlook_msg_default_000001",
      }),
    );
    expect(email).toMatchObject({
      messageId: "outlook_msg_default_000001",
      threadId: "outlook_thread_default_000001",
      body: {
        format: "text",
        content: "The fake quarterly invoice is attached.",
      },
      labelIds: ["inbox"],
      draft: false,
    });

    const searched = executionOutput(
      await harness.execute("microsoft-outlook.search_emails", {
        query: '"invoice"',
      }),
    );
    expect(searched).toMatchObject({
      emails: [{ messageId: "outlook_msg_default_000001" }],
    });

    const reply = executionOutput(
      await harness.execute("microsoft-outlook.reply_to_email", {
        messageId: "outlook_msg_default_000001",
        body: "Thanks, the quarterly invoice is approved.",
      }),
    );
    expect(reply).toMatchObject({
      threadId: "outlook_thread_default_000001",
      acceptedRecipients: ["billing@acme.example"],
    });

    const draft = executionOutput(
      await harness.execute("microsoft-outlook.create_draft", {
        to: ["reviewer@example.com"],
        subject: "Outlook draft",
        body: "Please review this Graph draft.",
      }),
    );
    expect(draft).toMatchObject({
      draftId: expect.any(String),
      messageId: expect.any(String),
      threadId: expect.any(String),
    });
    expect(storeRecords<OutlookDraft>(provider, "drafts")).toHaveLength(1);

    const threads = executionOutput(
      await harness.execute("microsoft-outlook.list_threads", {}),
    );
    expect(threads).toMatchObject({
      threads: expect.arrayContaining([
        expect.objectContaining({
          threadId: "outlook_thread_default_000001",
          messageCount: 2,
          unread: true,
        }),
      ]),
    });

    const labeled = executionOutput(
      await harness.execute("microsoft-outlook.add_email_label", {
        messageId: "outlook_msg_default_000001",
        labelId: "Inbox",
        operation: "move",
      }),
    );
    expect(labeled).toEqual({
      messageId: "outlook_msg_default_000001",
      labelId: "inbox",
      applied: true,
    });
  });
});
