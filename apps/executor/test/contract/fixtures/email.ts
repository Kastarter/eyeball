import { defineCapabilityFixtures } from "../fixtures.js";

function messageId(provider: string): string {
  return provider === "microsoft-outlook"
    ? "outlook_msg_default_000001"
    : "msg_default_000001";
}

function sendingExtension(provider: string): Readonly<Record<string, unknown>> {
  switch (provider) {
    case "mailgun":
      return {
        x_provider: {
          mailgun: {
            domain: "sandbox.example.com",
            from: "Contract Sender <sender@example.com>",
          },
        },
      };
    case "resend":
      return { x_provider: { resend: { from: "sender@example.com" } } };
    case "sendgrid":
      return { x_provider: { sendgrid: { from: "sender@example.com" } } };
    case "smtp":
      return { x_provider: { smtp: { from: "sender@example.com" } } };
    default:
      return {};
  }
}

export const emailFixtures = defineCapabilityFixtures("email", {
  add_email_label: {
    input: (context) => ({
      messageId: context.value("MESSAGE_ID", messageId(context.provider)),
      labelId: context.provider === "microsoft-outlook" ? "Inbox" : "UNREAD",
      operation: context.provider === "microsoft-outlook" ? "move" : "add",
    }),
  },
  create_draft: {
    input: {
      to: ["contract-recipient@example.com"],
      subject: "Contract fixture draft",
      body: "Canonical contract draft body.",
    },
  },
  get_email: {
    dependencies: ["send_email"],
    input: (context) => ({
      messageId: context.field("send_email", "messageId"),
      includeBody: true,
    }),
  },
  list_emails: {
    input: (context) => ({
      pageSize: 10,
      ...(context.provider === "mailgun"
        ? {
            x_provider: {
              mailgun: { domain: "sandbox.example.com" },
            },
          }
        : {}),
    }),
  },
  list_threads: { input: { pageSize: 10 } },
  reply_to_email: {
    input: (context) => ({
      messageId: context.value("MESSAGE_ID", messageId(context.provider)),
      body: "Canonical contract reply body.",
    }),
  },
  search_emails: { input: { query: "fixture", pageSize: 10 } },
  send_email: {
    input: (context) => ({
      to: ["contract-recipient@example.com"],
      subject: "Contract fixture delivery",
      body: "Canonical contract delivery body.",
      ...sendingExtension(context.provider),
    }),
  },
});
