import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  createProviderHttpClient,
  type ProviderHttpClient,
} from "../http-client.js";
import {
  acceptedRecipients,
  asJson,
  assertNoAttachments,
  booleanValue,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  providerError,
  requiredStringField,
  stringArrayValue,
  stringValue,
  unique,
  unsupportedTool,
} from "./common.js";

function graphRecipient(address: string) {
  return { emailAddress: { address } };
}

function graphRecipients(addresses: readonly string[]) {
  return addresses.map(graphRecipient);
}

function graphAddress(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.emailAddress)) {
    return undefined;
  }
  return stringValue(value.emailAddress, "address");
}

function graphAddresses(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((recipient) => {
        const address = graphAddress(recipient);
        return address === undefined ? [] : [address];
      })
    : [];
}

function graphBody(input: Readonly<Record<string, unknown>>) {
  return {
    contentType: stringValue(input, "bodyFormat") === "html" ? "HTML" : "Text",
    content: stringValue(input, "body") ?? "",
  };
}

function graphMessageInput(input: Readonly<Record<string, unknown>>) {
  const replyTo = stringValue(input, "replyTo");
  return {
    subject: stringValue(input, "subject") ?? "",
    body: graphBody(input),
    toRecipients: graphRecipients(stringArrayValue(input, "to")),
    ccRecipients: graphRecipients(stringArrayValue(input, "cc")),
    bccRecipients: graphRecipients(stringArrayValue(input, "bcc")),
    replyTo: replyTo === undefined ? [] : [graphRecipient(replyTo)],
  };
}

function graphMessageBody(
  message: Readonly<Record<string, unknown>>,
): { content: string; format: "html" | "text" } | undefined {
  if (!isRecord(message.body)) {
    return undefined;
  }
  const content = stringValue(message.body, "content");
  if (content === undefined) {
    return undefined;
  }
  return {
    format:
      stringValue(message.body, "contentType")?.toLowerCase() === "html"
        ? "html"
        : "text",
    content,
  };
}

function receivedAt(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): string {
  const value = stringValue(message, "receivedDateTime");
  if (value === undefined || Number.isNaN(new Date(value).valueOf())) {
    throw providerError(
      context,
      "Microsoft Graph returned an invalid receivedDateTime value.",
    );
  }
  return new Date(value).toISOString();
}

function messageLabels(message: Readonly<Record<string, unknown>>): string[] {
  const folderId = stringValue(message, "parentFolderId");
  return unique([
    ...(folderId === undefined ? [] : [folderId]),
    ...stringArrayValue(message, "categories"),
  ]);
}

function graphSummary(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    messageId: requiredStringField(context, message, "id"),
    ...(stringValue(message, "conversationId") === undefined
      ? {}
      : { threadId: stringValue(message, "conversationId") }),
    from: graphAddress(message.from) ?? "unknown@example.invalid",
    to: graphAddresses(message.toRecipients),
    subject: stringValue(message, "subject") ?? "",
    ...(stringValue(message, "bodyPreview") === undefined
      ? {}
      : { snippet: stringValue(message, "bodyPreview") }),
    receivedAt: receivedAt(context, message),
    unread: booleanValue(message, "isRead") !== true,
    hasAttachments: booleanValue(message, "hasAttachments") === true,
    labelIds: messageLabels(message),
  };
}

async function graphPage(
  context: AdapterContext,
  client: ProviderHttpClient,
  search: URLSearchParams,
): Promise<{
  messages: Readonly<Record<string, unknown>>[];
  nextPageToken?: string;
}> {
  const response = await client(`v1.0/me/messages?${search.toString()}`, {
    headers: { ConsistencyLevel: "eventual" },
  });
  const body = await jsonObject(context, response);
  const messages = Array.isArray(body.value) ? body.value.filter(isRecord) : [];
  const nextLink = stringValue(body, "@odata.nextLink");
  const nextPageToken =
    nextLink === undefined
      ? undefined
      : (new URL(nextLink).searchParams.get("$skiptoken") ?? undefined);
  return {
    messages,
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  };
}

function listParams(input: Readonly<Record<string, unknown>>): URLSearchParams {
  const search = new URLSearchParams({
    $top: String(numberValue(input, "pageSize") ?? 50),
  });
  const pageToken = stringValue(input, "pageToken");
  if (pageToken !== undefined) {
    search.set("$skiptoken", pageToken);
  }
  return search;
}

function matchesListFilters(
  context: AdapterContext,
  message: Readonly<Record<string, unknown>>,
): boolean {
  const input = context.canonicalInput;
  const folderId = stringValue(input, "folderId");
  const labels = stringArrayValue(input, "labelIds");
  const from = stringValue(input, "from")?.toLowerCase();
  const to = stringValue(input, "to")?.toLowerCase();
  const subject = stringValue(input, "subject")?.toLowerCase();
  const after = stringValue(input, "receivedAfter");
  const before = stringValue(input, "receivedBefore");
  const hasAttachments = booleanValue(input, "hasAttachments");
  const messageReceivedAt = receivedAt(context, message);
  const messageFrom = graphAddress(message.from)?.toLowerCase();
  const messageTo = graphAddresses(message.toRecipients).map((address) =>
    address.toLowerCase(),
  );
  const messageSubject = (stringValue(message, "subject") ?? "").toLowerCase();
  const messageLabelIds = messageLabels(message);
  return (
    (folderId === undefined ||
      stringValue(message, "parentFolderId") === folderId) &&
    labels.every((label) => messageLabelIds.includes(label)) &&
    (from === undefined || messageFrom === from) &&
    (to === undefined || messageTo.includes(to)) &&
    (subject === undefined || messageSubject.includes(subject)) &&
    (after === undefined || messageReceivedAt >= after) &&
    (before === undefined || messageReceivedAt < before) &&
    (booleanValue(input, "unreadOnly") !== true ||
      booleanValue(message, "isRead") !== true) &&
    (hasAttachments === undefined ||
      booleanValue(message, "hasAttachments") === hasAttachments)
  );
}

async function locateSentMessage(
  context: AdapterContext,
  client: ProviderHttpClient,
  subject: string,
  conversationId?: string,
  excludedMessageId?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const search = new URLSearchParams({ $top: "100" });
  if (conversationId === undefined && subject.length > 0) {
    search.set("$search", subject);
  }
  const page = await graphPage(context, client, search);
  const candidate = page.messages
    .filter(
      (message) =>
        booleanValue(message, "isDraft") !== true &&
        (conversationId === undefined ||
          stringValue(message, "conversationId") === conversationId) &&
        (excludedMessageId === undefined ||
          stringValue(message, "id") !== excludedMessageId) &&
        (subject.length === 0 || stringValue(message, "subject") === subject),
    )
    .sort((left, right) =>
      receivedAt(context, right).localeCompare(receivedAt(context, left)),
    )[0];
  if (candidate === undefined) {
    throw providerError(
      context,
      "Microsoft Graph accepted the operation but its created message could not be resolved.",
    );
  }
  return candidate;
}

export class MicrosoftOutlookAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "microsoft-outlook";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "microsoft-outlook.send_email":
        return this.sendEmail(context);
      case "microsoft-outlook.list_emails":
        return this.listEmails(context);
      case "microsoft-outlook.get_email":
        return this.getEmail(context);
      case "microsoft-outlook.reply_to_email":
        return this.replyToEmail(context);
      case "microsoft-outlook.create_draft":
        return this.createDraft(context);
      case "microsoft-outlook.search_emails":
        return this.searchEmails(context);
      case "microsoft-outlook.list_threads":
        return this.listThreads(context);
      case "microsoft-outlook.add_email_label":
        return this.addEmailLabel(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async sendEmail(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    await client(
      "v1.0/me/sendMail",
      jsonRequest({ message: graphMessageInput(input), saveToSentItems: true }),
    );
    const subject = stringValue(input, "subject") ?? "";
    const created = await locateSentMessage(context, client, subject);
    return asJson({
      messageId: requiredStringField(context, created, "id"),
      ...(stringValue(created, "conversationId") === undefined
        ? {}
        : { threadId: stringValue(created, "conversationId") }),
      acceptedRecipients: acceptedRecipients(input),
    });
  }

  private async listEmails(context: AdapterContext): Promise<JsonValue> {
    const page = await graphPage(
      context,
      createProviderHttpClient(context),
      listParams(context.canonicalInput),
    );
    return asJson({
      emails: page.messages
        .filter((message) => matchesListFilters(context, message))
        .map((message) => graphSummary(context, message)),
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    });
  }

  private async getEmail(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const response = await createProviderHttpClient(context)(
      `v1.0/me/messages/${encodeURIComponent(
        stringValue(input, "messageId") ?? "",
      )}`,
    );
    const message = await jsonObject(context, response);
    const body = graphMessageBody(message);
    return asJson({
      messageId: requiredStringField(context, message, "id"),
      ...(stringValue(message, "conversationId") === undefined
        ? {}
        : { threadId: stringValue(message, "conversationId") }),
      from: graphAddress(message.from) ?? "unknown@example.invalid",
      to: graphAddresses(message.toRecipients),
      cc: graphAddresses(message.ccRecipients),
      bcc: graphAddresses(message.bccRecipients),
      subject: stringValue(message, "subject") ?? "",
      ...(stringValue(message, "sentDateTime") === undefined
        ? {}
        : { sentAt: stringValue(message, "sentDateTime") }),
      receivedAt: receivedAt(context, message),
      ...(booleanValue(input, "includeBody") === false || body === undefined
        ? {}
        : { body }),
      ...(booleanValue(input, "includeAttachmentMetadata") === false
        ? {}
        : { attachments: [] }),
      labelIds: messageLabels(message),
      draft: booleanValue(message, "isDraft") === true,
    });
  }

  private async replyToEmail(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    const messageId = stringValue(input, "messageId") ?? "";
    const original = await jsonObject(
      context,
      await client(`v1.0/me/messages/${encodeURIComponent(messageId)}`),
    );
    const explicitTo = stringArrayValue(input, "to");
    const explicitCc = stringArrayValue(input, "cc");
    const bcc = stringArrayValue(input, "bcc");
    const replyAll = booleanValue(input, "replyAll") === true;
    const to =
      explicitTo.length > 0
        ? explicitTo
        : unique([
            graphAddress(original.from) ?? "unknown@example.invalid",
            ...(replyAll ? graphAddresses(original.toRecipients) : []),
          ]);
    const cc =
      explicitCc.length > 0
        ? explicitCc
        : replyAll
          ? graphAddresses(original.ccRecipients)
          : [];
    await client(
      `v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
      jsonRequest({
        comment: stringValue(input, "body") ?? "",
        message: {
          toRecipients: graphRecipients(to),
          ccRecipients: graphRecipients(cc),
          bccRecipients: graphRecipients(bcc),
        },
      }),
    );
    const originalSubject = stringValue(original, "subject") ?? "";
    const replySubject = originalSubject.toLowerCase().startsWith("re:")
      ? originalSubject
      : `Re: ${originalSubject}`;
    const conversationId = requiredStringField(
      context,
      original,
      "conversationId",
    );
    const created = await locateSentMessage(
      context,
      client,
      replySubject,
      conversationId,
      messageId,
    );
    return asJson({
      messageId: requiredStringField(context, created, "id"),
      threadId: stringValue(created, "conversationId") ?? conversationId,
      acceptedRecipients: unique([...to, ...cc, ...bcc]),
    });
  }

  private async createDraft(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const response = await createProviderHttpClient(context)(
      "v1.0/me/messages",
      jsonRequest(graphMessageInput(context.canonicalInput)),
    );
    const message = await jsonObject(context, response);
    const messageId = requiredStringField(context, message, "id");
    return asJson({
      draftId: messageId,
      messageId,
      ...(stringValue(message, "conversationId") === undefined
        ? {}
        : { threadId: stringValue(message, "conversationId") }),
    });
  }

  private async searchEmails(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = listParams(input);
    search.set("$search", stringValue(input, "query") ?? "");
    const page = await graphPage(
      context,
      createProviderHttpClient(context),
      search,
    );
    const folderId = stringValue(input, "folderId");
    const messages = page.messages.filter(
      (message) =>
        folderId === undefined ||
        stringValue(message, "parentFolderId") === folderId,
    );
    return asJson({
      emails: messages.map((message) => graphSummary(context, message)),
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    });
  }

  private async listThreads(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const page = await graphPage(
      context,
      createProviderHttpClient(context),
      listParams(input),
    );
    const grouped = new Map<string, Readonly<Record<string, unknown>>[]>();
    for (const message of page.messages) {
      const conversationId = stringValue(message, "conversationId");
      if (conversationId === undefined) {
        continue;
      }
      const messages = grouped.get(conversationId) ?? [];
      messages.push(message);
      grouped.set(conversationId, messages);
    }

    const requiredLabels = stringArrayValue(input, "labelIds");
    const requiredParticipants = stringArrayValue(
      input,
      "participantAddresses",
    ).map((address) => address.toLowerCase());
    const after = stringValue(input, "receivedAfter");
    const before = stringValue(input, "receivedBefore");
    const threads = [...grouped.entries()].flatMap(
      ([threadId, threadMessages]) => {
        const messages = [...threadMessages].sort((left, right) =>
          receivedAt(context, right).localeCompare(receivedAt(context, left)),
        );
        const latest = messages[0];
        if (latest === undefined) {
          return [];
        }
        const participants = unique(
          messages.flatMap((message) => [
            ...(graphAddress(message.from) === undefined
              ? []
              : [graphAddress(message.from) as string]),
            ...graphAddresses(message.toRecipients),
            ...graphAddresses(message.ccRecipients),
          ]),
        );
        const participantSet = new Set(
          participants.map((address) => address.toLowerCase()),
        );
        const latestMessageAt = receivedAt(context, latest);
        const unread = messages.some(
          (message) => booleanValue(message, "isRead") !== true,
        );
        if (
          !requiredLabels.every((label) =>
            messages.some((message) => messageLabels(message).includes(label)),
          ) ||
          (requiredParticipants.length > 0 &&
            !requiredParticipants.some((address) =>
              participantSet.has(address),
            )) ||
          (after !== undefined && latestMessageAt < after) ||
          (before !== undefined && latestMessageAt >= before) ||
          (booleanValue(input, "unreadOnly") === true && !unread)
        ) {
          return [];
        }
        return [
          {
            threadId,
            subject: stringValue(latest, "subject") ?? "",
            participantAddresses: participants,
            messageCount: messages.length,
            latestMessageAt,
            ...(stringValue(latest, "bodyPreview") === undefined
              ? {}
              : { snippet: stringValue(latest, "bodyPreview") }),
            unread,
          },
        ];
      },
    );
    return asJson({
      threads,
      ...(page.nextPageToken === undefined
        ? {}
        : { nextPageToken: page.nextPageToken }),
    });
  }

  private async addEmailLabel(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const client = createProviderHttpClient(context);
    const messageId = stringValue(input, "messageId") ?? "";
    const message = await jsonObject(
      context,
      await client(`v1.0/me/messages/${encodeURIComponent(messageId)}`),
    );
    const folders = await jsonObject(
      context,
      await client("v1.0/me/mailFolders"),
    );
    const requestedLabel = stringValue(input, "labelId") ?? "";
    const folder = Array.isArray(folders.value)
      ? folders.value.filter(isRecord).find((candidate) => {
          const id = stringValue(candidate, "id");
          const name = stringValue(candidate, "displayName");
          return (
            id === requestedLabel ||
            name?.toLowerCase() === requestedLabel.toLowerCase()
          );
        })
      : undefined;
    const resolvedLabel = stringValue(folder ?? {}, "id") ?? requestedLabel;
    const folderName = stringValue(folder ?? {}, "displayName");
    const categories = stringArrayValue(message, "categories");
    const operation = stringValue(input, "operation") ?? "add";
    const category = folderName ?? requestedLabel;
    const alreadyApplied =
      operation === "move"
        ? folder !== undefined &&
          stringValue(message, "parentFolderId") === resolvedLabel
        : categories.includes(category);
    let updated = message;
    if (!alreadyApplied && operation === "move") {
      if (folder === undefined) {
        throw new EyeballError({
          code: TOOL_ERROR_CODES.NOT_FOUND,
          message: `Microsoft Graph mail folder was not found: ${requestedLabel}`,
          providerDetail: { toolkit: this.toolkitSlug },
        });
      }
      updated = await jsonObject(
        context,
        await client(
          `v1.0/me/messages/${encodeURIComponent(messageId)}/move`,
          jsonRequest({ destinationId: resolvedLabel }),
        ),
      );
    } else if (!alreadyApplied) {
      updated = await jsonObject(
        context,
        await client(
          `v1.0/me/messages/${encodeURIComponent(messageId)}`,
          jsonRequest(
            { categories: unique([...categories, category]) },
            "PATCH",
          ),
        ),
      );
    }
    const applied =
      operation === "move"
        ? stringValue(updated, "parentFolderId") === resolvedLabel
        : stringArrayValue(updated, "categories").includes(category);
    return asJson({
      messageId: requiredStringField(context, updated, "id"),
      labelId: resolvedLabel,
      applied,
    });
  }
}

export const microsoftOutlookAdapter = new MicrosoftOutlookAdapter();
