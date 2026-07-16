import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  booleanValue,
  finiteNumber,
  inputString,
  isoString,
  jsonObject,
  jsonRequest,
  page,
  parseOffsetToken,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringArray,
  stringValue,
  unsupported,
} from "./common.js";

const API_ROOT = "api/v2";

function customFieldObject(value: unknown): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    records(value)
      .map((field) => {
        const id =
          typeof field.id === "string" || typeof field.id === "number"
            ? String(field.id)
            : undefined;
        return id === undefined ? undefined : ([id, field.value] as const);
      })
      .filter(
        (entry): entry is readonly [string, unknown] => entry !== undefined,
      ),
  );
}

function customFieldList(value: unknown): Readonly<Record<string, unknown>>[] {
  const fields = recordValue({ value }, "value");
  return fields === undefined
    ? []
    : Object.entries(fields).map(([id, fieldValue]) => ({
        id,
        value: fieldValue,
      }));
}

function ticket(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ticketId: requiredId(context, value.id, "ticket"),
    subject: requiredString(context, value, "subject"),
    description: requiredString(context, value, "description"),
    requesterId: requiredId(context, value.requester_id, "requester"),
    ...(value.submitter_id === undefined
      ? {}
      : { submitterId: requiredId(context, value.submitter_id, "submitter") }),
    ...(value.assignee_id === null || value.assignee_id === undefined
      ? {}
      : { assigneeId: requiredId(context, value.assignee_id, "assignee") }),
    status: requiredString(context, value, "status"),
    priority: requiredString(context, value, "priority"),
    tags: stringArray(value.tags),
    customFields: customFieldObject(value.custom_fields),
    createdAt: isoString(context, value.created_at, "created_at"),
    updatedAt: isoString(context, value.updated_at, "updated_at"),
  };
}

function message(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    messageId: requiredId(context, value.id, "message"),
    conversationId: requiredId(context, value.ticket_id, "conversation"),
    authorId: requiredId(context, value.author_id, "author"),
    body: requiredString(context, value, "body"),
    public: booleanValue(value, "public") ?? true,
    createdAt: isoString(context, value.created_at, "created_at"),
  };
}

function conversation(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    conversationId: requiredId(context, value.id, "conversation"),
    subject: requiredString(context, value, "subject"),
    status: requiredString(context, value, "status"),
    ...(value.assignee_id === null || value.assignee_id === undefined
      ? {}
      : { assigneeId: requiredId(context, value.assignee_id, "assignee") }),
    messageCount: finiteNumber(
      context,
      value.message_count,
      "message count",
      0,
    ),
    updatedAt: isoString(context, value.updated_at, "updated_at"),
  };
}

function conversationFromTicket(
  value: Readonly<Record<string, unknown>>,
  messageCount: number,
): Readonly<Record<string, unknown>> {
  return {
    conversationId: value.ticketId,
    subject: value.subject,
    status: value.status,
    ...(value.assigneeId === undefined ? {} : { assigneeId: value.assigneeId }),
    messageCount,
    updatedAt: value.updatedAt,
  };
}

function wrapped(
  context: AdapterContext,
  body: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = recordValue(body, key);
  if (value === undefined) {
    throw providerError(
      context,
      `Zendesk omitted the required ${key} response object.`,
    );
  }
  return value;
}

function pageSettings(context: AdapterContext): {
  offset: number;
  pageSize: number;
} {
  return {
    offset: parseOffsetToken(
      context,
      stringValue(context.canonicalInput, "pageToken"),
    ),
    pageSize:
      typeof context.canonicalInput.pageSize === "number"
        ? context.canonicalInput.pageSize
        : 50,
  };
}

function ticketPatch(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...(stringValue(input, "subject") === undefined
      ? {}
      : { subject: stringValue(input, "subject") }),
    ...(stringValue(input, "description") === undefined
      ? {}
      : { description: stringValue(input, "description") }),
    ...(stringValue(input, "status") === undefined
      ? {}
      : { status: stringValue(input, "status") }),
    ...(stringValue(input, "priority") === undefined
      ? {}
      : { priority: stringValue(input, "priority") }),
    ...(input.tags === undefined ? {} : { tags: stringArray(input.tags) }),
    ...(input.customFields === undefined
      ? {}
      : { custom_fields: customFieldList(input.customFields) }),
  };
}

export class ZendeskAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "zendesk";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "zendesk.create_ticket":
        return this.createTicket(context);
      case "zendesk.get_ticket":
        return this.getTicket(context);
      case "zendesk.list_tickets":
        return this.listTickets(context);
      case "zendesk.update_ticket":
        return this.updateTicket(context);
      case "zendesk.add_ticket_reply":
        return this.addReply(context, "comment");
      case "zendesk.assign_ticket":
        return this.assignTicket(context);
      case "zendesk.list_conversations":
        return this.listConversations(context);
      case "zendesk.get_conversation":
        return this.getConversation(context);
      case "zendesk.send_conversation_reply":
        return this.addReply(context, "reply");
      default:
        return unsupported(context);
    }
  }

  private async createTicket(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/tickets`,
      jsonRequest({
        ticket: {
          requester: {
            email: inputString(context, "requesterEmail"),
            name:
              stringValue(input, "requesterName") ??
              inputString(context, "requesterEmail"),
            ...(stringValue(input, "requesterPhone") === undefined
              ? {}
              : { phone: stringValue(input, "requesterPhone") }),
          },
          subject: inputString(context, "subject"),
          description: inputString(context, "description"),
          priority: stringValue(input, "priority") ?? "normal",
          tags: stringArray(input.tags),
          custom_fields: customFieldList(input.customFields),
        },
      }),
    );
    return asJson({
      ticket: ticket(context, wrapped(context, body, "ticket")),
    });
  }

  private async getTicket(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `${API_ROOT}/tickets/${encodeURIComponent(inputString(context, "ticketId"))}`,
    );
    return asJson({
      ticket: ticket(context, wrapped(context, body, "ticket")),
    });
  }

  private async listTickets(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({ per_page: "100", page: "1" });
    const status = stringValue(input, "status");
    const assigneeId = stringValue(input, "assigneeId");
    if (status !== undefined) search.set("status", status);
    if (assigneeId !== undefined) search.set("assignee_id", assigneeId);
    const body = await jsonObject(
      context,
      `${API_ROOT}/tickets?${search.toString()}`,
    );
    const requesterId = stringValue(input, "requesterId");
    const priority = stringValue(input, "priority");
    const updatedAfter = stringValue(input, "updatedAfter");
    const updatedBefore = stringValue(input, "updatedBefore");
    const normalized = records(body.tickets)
      .map((entry) => ticket(context, entry))
      .filter((entry) => {
        const updatedAt = String(entry.updatedAt);
        return (
          (requesterId === undefined || entry.requesterId === requesterId) &&
          (priority === undefined || entry.priority === priority) &&
          (updatedAfter === undefined || updatedAt >= updatedAfter) &&
          (updatedBefore === undefined || updatedAt < updatedBefore)
        );
      });
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      tickets: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async updateTicket(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/tickets/${encodeURIComponent(inputString(context, "ticketId"))}`,
      jsonRequest({ ticket: ticketPatch(input) }, "PUT"),
    );
    return asJson({
      ticket: ticket(context, wrapped(context, body, "ticket")),
    });
  }

  private async assignTicket(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `${API_ROOT}/tickets/${encodeURIComponent(inputString(context, "ticketId"))}`,
      jsonRequest(
        {
          ticket: {
            assignee_id: inputString(context, "assigneeId"),
          },
        },
        "PUT",
      ),
    );
    return asJson({
      ticket: ticket(context, wrapped(context, body, "ticket")),
    });
  }

  private async addReply(
    context: AdapterContext,
    kind: "comment" | "reply",
  ): Promise<JsonValue> {
    const input = context.canonicalInput;
    const idField = kind === "comment" ? "ticketId" : "conversationId";
    const path =
      kind === "comment"
        ? `${API_ROOT}/tickets/${encodeURIComponent(inputString(context, idField))}/comments`
        : `${API_ROOT}/conversations/${encodeURIComponent(inputString(context, idField))}/replies`;
    const payload = {
      body: inputString(context, "body"),
      public: input.public !== false,
      ...(stringValue(input, "authorId") === undefined
        ? {}
        : { author_id: stringValue(input, "authorId") }),
    };
    const body = await jsonObject(
      context,
      path,
      jsonRequest({ [kind]: payload }),
    );
    return asJson({ message: message(context, wrapped(context, body, kind)) });
  }

  private async listConversations(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams();
    const status = stringValue(input, "status");
    if (status !== undefined) search.set("status", status);
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    const body = await jsonObject(
      context,
      `${API_ROOT}/conversations${suffix}`,
    );
    const assigneeId = stringValue(input, "assigneeId");
    const updatedAfter = stringValue(input, "updatedAfter");
    const updatedBefore = stringValue(input, "updatedBefore");
    const normalized = records(body.conversations)
      .map((entry) => conversation(context, entry))
      .filter((entry) => {
        const updatedAt = String(entry.updatedAt);
        return (
          (assigneeId === undefined || entry.assigneeId === assigneeId) &&
          (updatedAfter === undefined || updatedAt >= updatedAfter) &&
          (updatedBefore === undefined || updatedAt < updatedBefore)
        );
      });
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      conversations: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async getConversation(context: AdapterContext): Promise<JsonValue> {
    const conversationId = inputString(context, "conversationId");
    const [ticketBody, commentsBody] = await Promise.all([
      jsonObject(
        context,
        `${API_ROOT}/tickets/${encodeURIComponent(conversationId)}`,
      ),
      jsonObject(
        context,
        `${API_ROOT}/tickets/${encodeURIComponent(conversationId)}/comments`,
      ),
    ]);
    const normalizedMessages = records(commentsBody.comments).map((entry) =>
      message(context, entry),
    );
    const normalizedTicket = ticket(
      context,
      wrapped(context, ticketBody, "ticket"),
    );
    return asJson({
      conversation: conversationFromTicket(
        normalizedTicket,
        normalizedMessages.length,
      ),
      messages: normalizedMessages,
    });
  }
}

export const zendeskAdapter = new ZendeskAdapter();
