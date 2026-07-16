import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  createProviderHttpClient,
  type ProviderHttpClient,
} from "../http-client.js";
import {
  addressFromHeader,
  asJson,
  assertNoAttachments,
  booleanValue,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  optionalProviderString,
  providerError,
  requiredStringField,
  splitAddresses,
  stringArrayValue,
  stringValue,
  unique,
  unsupportedTool,
} from "./common.js";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailAttachment {
  attachmentId: string;
  fileName: string;
  contentType?: string;
  sizeBytes?: number;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function headersOf(message: Readonly<Record<string, unknown>>): GmailHeader[] {
  if (!isRecord(message.payload) || !Array.isArray(message.payload.headers)) {
    return [];
  }
  return message.payload.headers.flatMap((value) =>
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string"
      ? [{ name: value.name, value: value.value }]
      : [],
  );
}

function headerValue(
  message: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  return headersOf(message).find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

function labelIdsOf(message: Readonly<Record<string, unknown>>): string[] {
  return stringArrayValue(message, "labelIds");
}

interface CanonicalEmailBody {
  content: string;
  format: "html" | "text";
}

function bodyFromPart(
  part: Readonly<Record<string, unknown>>,
): CanonicalEmailBody | undefined {
  const mimeType = (stringValue(part, "mimeType") ?? "").toLowerCase();
  const body = isRecord(part.body) ? part.body : {};
  const data = stringValue(body, "data");
  if (
    data !== undefined &&
    (mimeType === "text/plain" || mimeType === "text/html")
  ) {
    return {
      format: mimeType === "text/html" ? "html" : "text",
      content: decodeBase64Url(data),
    };
  }
  const childBodies = Array.isArray(part.parts)
    ? part.parts.filter(isRecord).flatMap((child) => {
        const childBody = bodyFromPart(child);
        return childBody === undefined ? [] : [childBody];
      })
    : [];
  return (
    childBodies.find((candidate) => candidate.format === "html") ??
    childBodies[0]
  );
}

function messageBody(
  message: Readonly<Record<string, unknown>>,
): CanonicalEmailBody {
  return (
    (isRecord(message.payload) ? bodyFromPart(message.payload) : undefined) ?? {
      content: "",
      format: "text",
    }
  );
}

function collectAttachments(
  part: Readonly<Record<string, unknown>>,
  attachments: GmailAttachment[],
): void {
  const body = isRecord(part.body) ? part.body : {};
  const attachmentId = stringValue(body, "attachmentId");
  const fileName = stringValue(part, "filename");
  if (
    attachmentId !== undefined &&
    fileName !== undefined &&
    fileName.length > 0
  ) {
    const mimeType = stringValue(part, "mimeType");
    const sizeBytes = numberValue(body, "size");
    attachments.push({
      attachmentId,
      fileName,
      ...(mimeType === undefined ? {} : { contentType: mimeType }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      if (isRecord(child)) {
        collectAttachments(child, attachments);
      }
    }
  }
}

function attachmentsOf(
  message: Readonly<Record<string, unknown>>,
): GmailAttachment[] {
  if (!isRecord(message.payload)) {
    return [];
  }
  const attachments: GmailAttachment[] = [];
  collectAttachments(message.payload, attachments);
  return attachments;
}

function receivedAt(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): string {
  const internalDate = stringValue(message, "internalDate");
  const milliseconds =
    internalDate === undefined ? Number.NaN : Number(internalDate);
  const date = new Date(milliseconds);
  if (Number.isNaN(date.valueOf())) {
    throw providerError(
      context,
      "Gmail returned an invalid internalDate value.",
    );
  }
  return date.toISOString();
}

function summaryFromMessage(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const messageId = requiredStringField(context, message, "id");
  const from = addressFromHeader(
    headerValue(message, "From") ?? "unknown@example.invalid",
  );
  const labels = labelIdsOf(message);
  return {
    messageId,
    ...(stringValue(message, "threadId") === undefined
      ? {}
      : { threadId: stringValue(message, "threadId") }),
    from,
    to: splitAddresses(headerValue(message, "To") ?? ""),
    subject: headerValue(message, "Subject") ?? "",
    ...(stringValue(message, "snippet") === undefined
      ? {}
      : { snippet: stringValue(message, "snippet") }),
    receivedAt: receivedAt(context, message),
    unread: labels.includes("UNREAD"),
    hasAttachments: attachmentsOf(message).length > 0,
    labelIds: labels,
  };
}

function composeRaw(
  input: Readonly<Record<string, unknown>>,
  options: {
    from?: string;
    subject?: string;
    to?: readonly string[];
    cc?: readonly string[];
    bcc?: readonly string[];
  } = {},
): string {
  const to = options.to ?? stringArrayValue(input, "to");
  const cc = options.cc ?? stringArrayValue(input, "cc");
  const bcc = options.bcc ?? stringArrayValue(input, "bcc");
  const headers: string[] = [];
  if (options.from !== undefined) {
    headers.push(`From: ${sanitizeHeader(options.from)}`);
  }
  if (to.length > 0) {
    headers.push(`To: ${to.map(sanitizeHeader).join(", ")}`);
  }
  if (cc.length > 0) {
    headers.push(`Cc: ${cc.map(sanitizeHeader).join(", ")}`);
  }
  if (bcc.length > 0) {
    headers.push(`Bcc: ${bcc.map(sanitizeHeader).join(", ")}`);
  }
  const replyTo = stringValue(input, "replyTo");
  if (replyTo !== undefined) {
    headers.push(`Reply-To: ${sanitizeHeader(replyTo)}`);
  }
  headers.push(
    `Subject: ${sanitizeHeader(options.subject ?? stringValue(input, "subject") ?? "")}`,
    "MIME-Version: 1.0",
    `Content-Type: ${
      stringValue(input, "bodyFormat") === "html" ? "text/html" : "text/plain"
    }; charset=UTF-8`,
    "Content-Transfer-Encoding: 8bit",
  );
  return encodeBase64Url(
    `${headers.join("\r\n")}\r\n\r\n${stringValue(input, "body") ?? ""}`,
  );
}

async function gmailMessage(
  context: AdapterContext,
  client: ProviderHttpClient,
  messageId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await client(
    `gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );
  return jsonObject(context, response);
}

async function listedMessages(
  context: AdapterContext,
  client: ProviderHttpClient,
  search: URLSearchParams,
): Promise<{
  messages: Readonly<Record<string, unknown>>[];
  nextPageToken?: string;
}> {
  const response = await client(
    `gmail/v1/users/me/messages?${search.toString()}`,
  );
  const body = await jsonObject(context, response);
  const references = Array.isArray(body.messages) ? body.messages : [];
  const ids = references.flatMap((reference) =>
    isRecord(reference) && typeof reference.id === "string"
      ? [reference.id]
      : [],
  );
  context.logger.debug("Resolving Gmail message details.", {
    messageCount: ids.length,
  });
  const messages = await Promise.all(
    ids.map((messageId) => gmailMessage(context, client, messageId)),
  );
  const nextPageToken = stringValue(body, "nextPageToken");
  return {
    messages,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  };
}

function listSearchParams(
  input: Readonly<Record<string, unknown>>,
): URLSearchParams {
  const search = new URLSearchParams();
  search.set("maxResults", String(numberValue(input, "pageSize") ?? 50));
  const pageToken = stringValue(input, "pageToken");
  if (pageToken !== undefined) {
    search.set("pageToken", pageToken);
  }
  const labels = unique([
    ...stringArrayValue(input, "labelIds"),
    ...(stringValue(input, "folderId") === undefined
      ? []
      : [stringValue(input, "folderId") as string]),
  ]);
  for (const labelId of labels) {
    search.append("labelIds", labelId);
  }
  const query: string[] = [];
  const from = stringValue(input, "from");
  const to = stringValue(input, "to");
  const subject = stringValue(input, "subject");
  if (from !== undefined) {
    query.push(`from:${JSON.stringify(from)}`);
  }
  if (to !== undefined) {
    query.push(`to:${JSON.stringify(to)}`);
  }
  if (subject !== undefined) {
    query.push(`subject:${JSON.stringify(subject)}`);
  }
  if (booleanValue(input, "unreadOnly") === true) {
    query.push("is:unread");
  }
  if (query.length > 0) {
    search.set("q", query.join(" "));
  }
  return search;
}

function matchesPortableFilters(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): boolean {
  const input = context.canonicalInput;
  const summary = summaryFromMessage(context, message);
  const after = stringValue(input, "receivedAfter");
  const before = stringValue(input, "receivedBefore");
  const hasAttachments = booleanValue(input, "hasAttachments");
  return (
    (after === undefined || String(summary.receivedAt) >= after) &&
    (before === undefined || String(summary.receivedAt) < before) &&
    (hasAttachments === undefined || summary.hasAttachments === hasAttachments)
  );
}

export class GmailAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "gmail";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "gmail.send_email":
        return this.sendEmail(context);
      case "gmail.list_emails":
        return this.listEmails(context);
      case "gmail.get_email":
        return this.getEmail(context);
      case "gmail.reply_to_email":
        return this.replyToEmail(context);
      case "gmail.create_draft":
        return this.createDraft(context);
      case "gmail.search_emails":
        return this.searchEmails(context);
      case "gmail.list_threads":
        return this.listThreads(context);
      case "gmail.add_email_label":
        return this.addEmailLabel(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async sendEmail(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const recipients = unique([
      ...stringArrayValue(input, "to"),
      ...stringArrayValue(input, "cc"),
      ...stringArrayValue(input, "bcc"),
    ]);
    const sendAs = optionalProviderString(context, this.toolkitSlug, "sendAs");
    const response = await createProviderHttpClient(context)(
      "gmail/v1/users/me/messages/send",
      jsonRequest({
        raw: composeRaw(input, {
          ...(sendAs === undefined ? {} : { from: sendAs }),
        }),
      }),
    );
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "id"),
      ...(stringValue(body, "threadId") === undefined
        ? {}
        : { threadId: stringValue(body, "threadId") }),
      acceptedRecipients: recipients,
    });
  }

  private async listEmails(context: AdapterContext): Promise<JsonValue> {
    const page = await listedMessages(
      context,
      createProviderHttpClient(context),
      listSearchParams(context.canonicalInput),
    );
    return asJson({
      emails: page.messages
        .filter((message) => matchesPortableFilters(context, message))
        .map((message) => summaryFromMessage(context, message)),
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    });
  }

  private async getEmail(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    const message = await gmailMessage(
      context,
      client,
      stringValue(input, "messageId") ?? "",
    );
    const labels = labelIdsOf(message);
    return asJson({
      messageId: requiredStringField(context, message, "id"),
      ...(stringValue(message, "threadId") === undefined
        ? {}
        : { threadId: stringValue(message, "threadId") }),
      from: addressFromHeader(
        headerValue(message, "From") ?? "unknown@example.invalid",
      ),
      to: splitAddresses(headerValue(message, "To") ?? ""),
      cc: splitAddresses(headerValue(message, "Cc") ?? ""),
      bcc: splitAddresses(headerValue(message, "Bcc") ?? ""),
      subject: headerValue(message, "Subject") ?? "",
      receivedAt: receivedAt(context, message),
      ...(booleanValue(input, "includeBody") === false
        ? {}
        : { body: messageBody(message) }),
      headers: headersOf(message),
      ...(booleanValue(input, "includeAttachmentMetadata") === false
        ? {}
        : { attachments: attachmentsOf(message) }),
      labelIds: labels,
      draft: labels.includes("DRAFT"),
    });
  }

  private async replyToEmail(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    const original = await gmailMessage(
      context,
      client,
      stringValue(input, "messageId") ?? "",
    );
    const explicitTo = stringArrayValue(input, "to");
    const originalFrom = addressFromHeader(
      headerValue(original, "From") ?? "unknown@example.invalid",
    );
    const to = explicitTo.length > 0 ? explicitTo : [originalFrom];
    const cc = unique([
      ...stringArrayValue(input, "cc"),
      ...(booleanValue(input, "replyAll") === true
        ? [
            ...splitAddresses(headerValue(original, "To") ?? ""),
            ...splitAddresses(headerValue(original, "Cc") ?? ""),
          ]
        : []),
    ]).filter((address) => !to.includes(address));
    const bcc = stringArrayValue(input, "bcc");
    const subject = headerValue(original, "Subject") ?? "";
    const threadId = requiredStringField(context, original, "threadId");
    const response = await client("gmail/v1/users/me/messages/send", {
      ...jsonRequest({
        threadId,
        raw: composeRaw(input, {
          to,
          cc,
          bcc,
          subject: subject.toLowerCase().startsWith("re:")
            ? subject
            : `Re: ${subject}`,
        }),
      }),
    });
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "id"),
      threadId: stringValue(body, "threadId") ?? threadId,
      acceptedRecipients: unique([...to, ...cc, ...bcc]),
    });
  }

  private async createDraft(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const response = await createProviderHttpClient(context)(
      "gmail/v1/users/me/drafts",
      jsonRequest({ message: { raw: composeRaw(context.canonicalInput) } }),
    );
    const body = await jsonObject(context, response);
    const message = isRecord(body.message) ? body.message : {};
    return asJson({
      draftId: requiredStringField(context, body, "id"),
      ...(stringValue(message, "id") === undefined
        ? {}
        : { messageId: stringValue(message, "id") }),
      ...(stringValue(message, "threadId") === undefined
        ? {}
        : { threadId: stringValue(message, "threadId") }),
    });
  }

  private async searchEmails(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({
      q: stringValue(input, "query") ?? "",
      maxResults: String(numberValue(input, "pageSize") ?? 50),
    });
    const pageToken = stringValue(input, "pageToken");
    if (pageToken !== undefined) {
      search.set("pageToken", pageToken);
    }
    const folderId = stringValue(input, "folderId");
    if (folderId !== undefined) {
      search.append("labelIds", folderId);
    }
    const page = await listedMessages(
      context,
      createProviderHttpClient(context),
      search,
    );
    return asJson({
      emails: page.messages.map((message) =>
        summaryFromMessage(context, message),
      ),
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    });
  }

  private async listThreads(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({
      maxResults: String(numberValue(input, "pageSize") ?? 50),
    });
    const pageToken = stringValue(input, "pageToken");
    if (pageToken !== undefined) {
      search.set("pageToken", pageToken);
    }
    for (const labelId of stringArrayValue(input, "labelIds")) {
      search.append("labelIds", labelId);
    }
    if (booleanValue(input, "unreadOnly") === true) {
      search.set("q", "is:unread");
    }
    const client = createProviderHttpClient(context);
    const response = await client(
      `gmail/v1/users/me/threads?${search.toString()}`,
    );
    const body = await jsonObject(context, response);
    const threadIds = Array.isArray(body.threads)
      ? body.threads.flatMap((thread) =>
          isRecord(thread) && typeof thread.id === "string" ? [thread.id] : [],
        )
      : [];
    const details = await Promise.all(
      threadIds.map(async (threadId) =>
        jsonObject(
          context,
          await client(
            `gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
          ),
        ),
      ),
    );
    const participantFilter = stringArrayValue(
      input,
      "participantAddresses",
    ).map((address) => address.toLowerCase());
    const after = stringValue(input, "receivedAfter");
    const before = stringValue(input, "receivedBefore");
    const threads = details.flatMap((thread) => {
      const messages = Array.isArray(thread.messages)
        ? thread.messages.filter(isRecord)
        : [];
      if (messages.length === 0) {
        return [];
      }
      const sorted = [...messages].sort((left, right) =>
        receivedAt(context, right).localeCompare(receivedAt(context, left)),
      );
      const latest = sorted[0];
      if (latest === undefined) {
        return [];
      }
      const participants = unique(
        messages.flatMap((message) => [
          addressFromHeader(
            headerValue(message, "From") ?? "unknown@example.invalid",
          ),
          ...splitAddresses(headerValue(message, "To") ?? ""),
          ...splitAddresses(headerValue(message, "Cc") ?? ""),
        ]),
      );
      const participantSet = new Set(
        participants.map((address) => address.toLowerCase()),
      );
      const latestAt = receivedAt(context, latest);
      if (
        (participantFilter.length > 0 &&
          !participantFilter.some((address) => participantSet.has(address))) ||
        (after !== undefined && latestAt < after) ||
        (before !== undefined && latestAt >= before)
      ) {
        return [];
      }
      return [
        {
          threadId: requiredStringField(context, thread, "id"),
          subject: headerValue(latest, "Subject") ?? "",
          participantAddresses: participants,
          messageCount: messages.length,
          latestMessageAt: latestAt,
          ...(stringValue(thread, "snippet") === undefined
            ? {}
            : { snippet: stringValue(thread, "snippet") }),
          unread: messages.some((message) =>
            labelIdsOf(message).includes("UNREAD"),
          ),
        },
      ];
    });
    const nextPageToken = stringValue(body, "nextPageToken");
    return asJson({
      threads,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }

  private async addEmailLabel(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    const requestedLabel = stringValue(input, "labelId") ?? "";
    const labelsBody = await jsonObject(
      context,
      await client("gmail/v1/users/me/labels"),
    );
    const labels = Array.isArray(labelsBody.labels)
      ? labelsBody.labels.filter(isRecord)
      : [];
    const label = labels.find(
      (candidate) =>
        stringValue(candidate, "id") === requestedLabel ||
        stringValue(candidate, "name") === requestedLabel,
    );
    const labelId =
      label === undefined ? requestedLabel : stringValue(label, "id");
    const operation = stringValue(input, "operation") ?? "add";
    const messageId = stringValue(input, "messageId") ?? "";
    const response = await client(
      `gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/modify`,
      jsonRequest({
        addLabelIds: [labelId],
        removeLabelIds:
          operation === "move" && labelId !== "INBOX" ? ["INBOX"] : [],
      }),
    );
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "id"),
      labelId: labelId ?? requestedLabel,
      applied: labelId !== undefined && labelIdsOf(body).includes(labelId),
    });
  }
}

export const gmailAdapter = new GmailAdapter();
