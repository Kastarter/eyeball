import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  acceptedRecipients,
  addressFromHeader,
  asJson,
  assertNoAttachments,
  booleanValue,
  isRecord,
  jsonObject,
  numberValue,
  providerError,
  requiredProviderString,
  requiredStringField,
  splitAddresses,
  stringArrayValue,
  stringValue,
  unsupportedTool,
} from "./common.js";

function mailgunClient(context: AdapterContext) {
  if (context.credential.type !== "api_key") {
    return createProviderHttpClient(context);
  }
  const apiKey = context.credential.values.apiKey;
  if (apiKey === undefined || apiKey.startsWith("fixture:")) {
    return createProviderHttpClient(context);
  }
  return createProviderHttpClient(context, {
    authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
  });
}

function mailgunForm(context: AdapterContext): FormData {
  const input = context.canonicalInput;
  const form = new FormData();
  form.set("from", requiredProviderString(context, "mailgun", "from"));
  for (const field of ["to", "cc", "bcc"] as const) {
    for (const address of stringArrayValue(input, field)) {
      form.append(field, address);
    }
  }
  form.set("subject", stringValue(input, "subject") ?? "");
  form.set(
    stringValue(input, "bodyFormat") === "html" ? "html" : "text",
    stringValue(input, "body") ?? "",
  );
  const replyTo = stringValue(input, "replyTo");
  if (replyTo !== undefined) {
    form.set("h:Reply-To", replyTo);
  }
  return form;
}

function mailgunTimestamp(
  context: AdapterContext,
  event: Readonly<Record<string, unknown>>,
): string {
  const timestamp = numberValue(event, "timestamp");
  const date = new Date((timestamp ?? Number.NaN) * 1_000);
  if (Number.isNaN(date.valueOf())) {
    throw providerError(
      context,
      "Mailgun returned an invalid event timestamp.",
    );
  }
  return date.toISOString();
}

function mailgunSummary(
  context: AdapterContext,
  event: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const message = isRecord(event.message) ? event.message : {};
  const headers = isRecord(message.headers) ? message.headers : {};
  const eventName = stringValue(event, "event") ?? "accepted";
  return {
    messageId: requiredStringField(context, headers, "message-id"),
    from: addressFromHeader(requiredStringField(context, headers, "from")),
    to: splitAddresses(requiredStringField(context, headers, "to")),
    subject: requiredStringField(context, headers, "subject"),
    receivedAt: mailgunTimestamp(context, event),
    unread: false,
    hasAttachments: false,
    labelIds: [eventName],
  };
}

function matchesMailgunFilters(
  context: AdapterContext,
  summary: Readonly<Record<string, unknown>>,
  domain: string,
): boolean {
  const input = context.canonicalInput;
  const mailboxId = stringValue(input, "mailboxId");
  const folderId = stringValue(input, "folderId");
  const requiredLabels = stringArrayValue(input, "labelIds");
  const from = stringValue(input, "from")?.toLowerCase();
  const to = stringValue(input, "to")?.toLowerCase();
  const subject = stringValue(input, "subject")?.toLowerCase();
  const after = stringValue(input, "receivedAfter");
  const before = stringValue(input, "receivedBefore");
  const summaryFrom = String(summary.from).toLowerCase();
  const summaryTo = (summary.to as readonly string[]).map((address) =>
    address.toLowerCase(),
  );
  const summarySubject = String(summary.subject).toLowerCase();
  const receivedAt = String(summary.receivedAt);
  const labels = summary.labelIds as readonly string[];
  return (
    (mailboxId === undefined || mailboxId === domain) &&
    (folderId === undefined || labels.includes(folderId)) &&
    requiredLabels.every((label) => labels.includes(label)) &&
    (from === undefined || summaryFrom === from) &&
    (to === undefined || summaryTo.includes(to)) &&
    (subject === undefined || summarySubject.includes(subject)) &&
    (after === undefined || receivedAt >= after) &&
    (before === undefined || receivedAt < before) &&
    booleanValue(input, "unreadOnly") !== true &&
    booleanValue(input, "hasAttachments") !== true
  );
}

export class MailgunAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "mailgun";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "mailgun.send_email":
        return this.sendEmail(context);
      case "mailgun.list_emails":
        return this.listEmails(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async sendEmail(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const domain = requiredProviderString(context, this.toolkitSlug, "domain");
    const recipients = acceptedRecipients(input);
    const response = await mailgunClient(context)(
      `v3/${encodeURIComponent(domain)}/messages`,
      {
        method: "POST",
        body: mailgunForm(context),
      },
    );
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "id"),
      acceptedRecipients: recipients,
    });
  }

  private async listEmails(context: AdapterContext): Promise<JsonValue> {
    const domain = requiredProviderString(context, this.toolkitSlug, "domain");
    const search = new URLSearchParams({ event: "accepted" });
    const recipient = stringValue(context.canonicalInput, "to");
    if (recipient !== undefined) {
      search.set("recipient", recipient);
    }
    const response = await mailgunClient(context)(
      `v3/${encodeURIComponent(domain)}/events?${search.toString()}`,
    );
    const body = await jsonObject(context, response);
    const summariesByMessageId = new Map<
      string,
      Readonly<Record<string, unknown>>
    >();
    for (const event of Array.isArray(body.items)
      ? body.items.filter(isRecord)
      : []) {
      const summary = mailgunSummary(context, event);
      if (matchesMailgunFilters(context, summary, domain)) {
        summariesByMessageId.set(String(summary.messageId), summary);
      }
    }
    const pageSize = numberValue(context.canonicalInput, "pageSize") ?? 50;
    return asJson({
      emails: [...summariesByMessageId.values()].slice(0, pageSize),
    });
  }
}

export const mailgunAdapter = new MailgunAdapter();
