import { validateInput } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  defaultCatalog,
  gmailManifest,
  mailgunManifest,
  microsoftOutlookManifest,
  resendManifest,
  sendGridManifest,
  smtpManifest,
} from "../src/index.js";

const expectedTools = [
  "gmail.add_email_label",
  "gmail.create_draft",
  "gmail.get_email",
  "gmail.list_emails",
  "gmail.list_threads",
  "gmail.reply_to_email",
  "gmail.search_emails",
  "gmail.send_email",
  "mailgun.list_emails",
  "mailgun.send_email",
  "microsoft-outlook.add_email_label",
  "microsoft-outlook.create_draft",
  "microsoft-outlook.get_email",
  "microsoft-outlook.list_emails",
  "microsoft-outlook.list_threads",
  "microsoft-outlook.reply_to_email",
  "microsoft-outlook.search_emails",
  "microsoft-outlook.send_email",
  "resend.send_email",
  "sendgrid.send_email",
  "smtp.send_email",
] as const;

describe("default email provider manifests", () => {
  it("materializes exactly the executable provider subsets", () => {
    expect(defaultCatalog.listTools().map(({ name }) => name)).toEqual(
      expectedTools,
    );
    expect(defaultCatalog.listManifests()).toHaveLength(6);
    expect(defaultCatalog.listToolkits()).toEqual(
      [
        gmailManifest,
        mailgunManifest,
        microsoftOutlookManifest,
        resendManifest,
        sendGridManifest,
        smtpManifest,
      ]
        .map(({ toolkit }) => toolkit)
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    );
  });

  it("keeps provider configuration inside the selected extension namespace", () => {
    const inputs = {
      "mailgun.send_email": {
        to: ["recipient@example.com"],
        subject: "Mailgun",
        body: "Body",
        x_provider: {
          mailgun: {
            domain: "sandbox.example.com",
            from: "sender@example.com",
          },
        },
      },
      "resend.send_email": {
        to: ["recipient@example.com"],
        subject: "Resend",
        body: "Body",
        x_provider: { resend: { from: "sender@example.com" } },
      },
      "sendgrid.send_email": {
        to: ["recipient@example.com"],
        subject: "SendGrid",
        body: "Body",
        x_provider: { sendgrid: { from: "sender@example.com" } },
      },
      "smtp.send_email": {
        to: ["recipient@example.com"],
        subject: "SMTP",
        body: "Body",
        x_provider: { smtp: { from: "sender@example.com" } },
      },
    } as const;

    for (const [name, input] of Object.entries(inputs)) {
      const tool = defaultCatalog.getTool(name);
      expect(tool, name).toBeDefined();
      expect(
        validateInput(tool as NonNullable<typeof tool>, input),
        name,
      ).toMatchObject({
        ok: true,
      });
    }
  });

  it("computes least-privilege Microsoft Graph scopes per operation", () => {
    expect(
      defaultCatalog.getEffectiveScopes("microsoft-outlook.send_email"),
    ).toMatchObject({
      required: [
        "https://graph.microsoft.com/Mail.Read",
        "https://graph.microsoft.com/Mail.Send",
      ],
    });
    expect(
      defaultCatalog.getEffectiveScopes("microsoft-outlook.list_emails"),
    ).toMatchObject({
      required: ["https://graph.microsoft.com/Mail.Read"],
    });
    expect(
      defaultCatalog.getEffectiveScopes("microsoft-outlook.create_draft"),
    ).toMatchObject({
      required: ["https://graph.microsoft.com/Mail.ReadWrite"],
    });
    expect(
      defaultCatalog.getEffectiveScopes("microsoft-outlook.list_threads"),
    ).toMatchObject({
      required: ["https://graph.microsoft.com/Mail.Read"],
    });
    expect(
      defaultCatalog.getEffectiveScopes("microsoft-outlook.add_email_label"),
    ).toMatchObject({
      required: ["https://graph.microsoft.com/Mail.ReadWrite"],
    });
  });

  it("freezes every shipped manifest", () => {
    for (const manifest of [
      gmailManifest,
      microsoftOutlookManifest,
      smtpManifest,
      sendGridManifest,
      resendManifest,
      mailgunManifest,
    ]) {
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.implements)).toBe(true);
    }
  });
});
