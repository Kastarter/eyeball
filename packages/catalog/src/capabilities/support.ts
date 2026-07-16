import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "customer_support" as const;
const VERSION = "1.0.0" as const;

const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const CREATE = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
} as const;
const UPDATE = {
  readOnly: false,
  destructive: false,
  idempotent: true,
  async: false,
} as const;

function id(description: string): JSONSchema202012 {
  return { type: "string", description, minLength: 1 };
}

function stringList(description: string): JSONSchema202012 {
  return {
    type: "array",
    description,
    items: { type: "string", minLength: 1 },
  };
}

function customFields(description: string): JSONSchema202012 {
  return {
    type: "object",
    description,
    additionalProperties: true,
  };
}

function ticketSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized customer-support ticket.",
    additionalProperties: false,
    required: [
      "ticketId",
      "subject",
      "description",
      "requesterId",
      "status",
      "priority",
      "tags",
      "customFields",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      ticketId: id("Provider identifier of the ticket."),
      subject: { type: "string", description: "Ticket subject." },
      description: {
        type: "string",
        description: "Initial ticket description.",
      },
      requesterId: id("Provider identifier of the requester."),
      submitterId: id("Provider identifier of the ticket submitter."),
      assigneeId: id("Provider identifier of the assigned agent or team."),
      status: { type: "string", description: "Ticket workflow state." },
      priority: { type: "string", description: "Ticket priority." },
      tags: stringList("Ticket tags."),
      customFields: customFields("Portable ticket custom-field values."),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Ticket creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent ticket update timestamp.",
      },
    },
  };
}

function messageSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "One normalized support reply, note, or conversation message.",
    additionalProperties: false,
    required: [
      "messageId",
      "conversationId",
      "authorId",
      "body",
      "public",
      "createdAt",
    ],
    properties: {
      messageId: id("Provider identifier of the reply or message."),
      conversationId: id("Provider identifier of the ticket or conversation."),
      authorId: id("Provider identifier of the message author."),
      body: { type: "string", description: "Plain-text message content." },
      public: {
        type: "boolean",
        description: "Whether the requester can see the message.",
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Message creation timestamp.",
      },
    },
  };
}

function conversationSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized customer-support inbox conversation.",
    additionalProperties: false,
    required: [
      "conversationId",
      "subject",
      "status",
      "messageCount",
      "updatedAt",
    ],
    properties: {
      conversationId: id("Provider identifier of the conversation."),
      subject: { type: "string", description: "Conversation subject." },
      status: { type: "string", description: "Conversation workflow state." },
      assigneeId: id("Provider identifier of the assigned agent or team."),
      messageCount: {
        type: "integer",
        description: "Number of messages currently in the conversation.",
        minimum: 0,
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent conversation update timestamp.",
      },
    },
  };
}

const createTicket = defineContract({
  capability: CAPABILITY,
  name: "create_ticket",
  description:
    "Create a support ticket with requester identity, subject, content, priority, tags, and portable custom fields.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_ticket",
    direction: "input",
    description: "Requester identity and initial ticket content.",
    required: ["requesterEmail", "subject", "description"],
    properties: {
      requesterEmail: {
        type: "string",
        format: "email",
        description: "Requester email address.",
      },
      requesterName: {
        type: "string",
        description: "Requester display name; defaults to the email address.",
      },
      requesterPhone: {
        type: "string",
        description: "Requester phone number.",
      },
      subject: {
        type: "string",
        description: "Ticket subject.",
        minLength: 1,
      },
      description: {
        type: "string",
        description: "Initial ticket description.",
        minLength: 1,
      },
      priority: {
        type: "string",
        description: "Initial ticket priority.",
        default: "normal",
      },
      tags: stringList("Initial ticket tags."),
      customFields: customFields("Portable custom-field values."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_ticket",
    direction: "output",
    description: "The newly created support ticket.",
    required: ["ticket"],
    properties: { ticket: ticketSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getTicket = defineContract({
  capability: CAPABILITY,
  name: "get_ticket",
  description:
    "Retrieve one support ticket with requester, status, assignment, tags, and portable custom fields.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_ticket",
    direction: "input",
    description: "Identifier of the ticket to retrieve.",
    required: ["ticketId"],
    properties: { ticketId: id("Provider identifier of the ticket.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_ticket",
    direction: "output",
    description: "The requested support ticket.",
    required: ["ticket"],
    properties: { ticket: ticketSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const listTickets = defineContract({
  capability: CAPABILITY,
  name: "list_tickets",
  description:
    "List support tickets using requester, assignee, state, priority, time, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_tickets",
    direction: "input",
    description: "Ticket filters and pagination.",
    properties: {
      requesterId: id("Provider identifier of the requester."),
      assigneeId: id("Provider identifier of the assigned agent or team."),
      status: {
        type: "string",
        description: "Ticket state to match.",
        minLength: 1,
      },
      priority: {
        type: "string",
        description: "Ticket priority to match.",
        minLength: 1,
      },
      updatedAfter: {
        type: "string",
        format: "date-time",
        description: "Return tickets updated at or after this timestamp.",
      },
      updatedBefore: {
        type: "string",
        format: "date-time",
        description: "Return tickets updated before this timestamp.",
      },
      pageSize: pageSizeProperty("tickets"),
      pageToken: pageTokenProperty("ticket"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_tickets",
    direction: "output",
    description: "One page of normalized support tickets.",
    required: ["tickets"],
    properties: {
      tickets: {
        type: "array",
        description: "Tickets in provider order.",
        items: ticketSchema(),
      },
      nextPageToken: nextPageTokenProperty("tickets"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateTicket = defineContract({
  capability: CAPABILITY,
  name: "update_ticket",
  description:
    "Update ticket subject, description, status, priority, tags, or portable custom fields. Repeating the same values has no additional effect.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_ticket",
    direction: "input",
    description: "Ticket identifier and fields to update.",
    required: ["ticketId"],
    properties: {
      ticketId: id("Provider identifier of the ticket."),
      subject: { type: "string", description: "Updated ticket subject." },
      description: {
        type: "string",
        description: "Updated ticket description.",
      },
      status: { type: "string", description: "Updated ticket state." },
      priority: { type: "string", description: "Updated ticket priority." },
      tags: stringList("Replacement ticket tags."),
      customFields: customFields("Replacement portable custom-field values."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_ticket",
    direction: "output",
    description: "The updated support ticket.",
    required: ["ticket"],
    properties: { ticket: ticketSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const addTicketReply = defineContract({
  capability: CAPABILITY,
  name: "add_ticket_reply",
  description:
    "Add a public reply or private internal note to a support ticket. This creates externally visible history when public is true.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_ticket_reply",
    direction: "input",
    description: "Ticket, reply content, visibility, and optional author.",
    required: ["ticketId", "body"],
    properties: {
      ticketId: id("Provider identifier of the ticket."),
      body: {
        type: "string",
        description: "Plain-text reply or note content.",
        minLength: 1,
      },
      public: {
        type: "boolean",
        description: "Whether the requester can see the reply.",
        default: true,
      },
      authorId: id("Provider identifier of the reply author."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_ticket_reply",
    direction: "output",
    description: "The newly created ticket reply or note.",
    required: ["message"],
    properties: { message: messageSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const assignTicket = defineContract({
  capability: CAPABILITY,
  name: "assign_ticket",
  description:
    "Assign a ticket to an agent, team, or group. Repeating the same assignment has no additional effect.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "assign_ticket",
    direction: "input",
    description: "Ticket and assignee identifiers.",
    required: ["ticketId", "assigneeId"],
    properties: {
      ticketId: id("Provider identifier of the ticket."),
      assigneeId: id(
        "Provider identifier of the target agent, team, or group.",
      ),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "assign_ticket",
    direction: "output",
    description: "The assigned support ticket.",
    required: ["ticket"],
    properties: { ticket: ticketSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const listConversations = defineContract({
  capability: CAPABILITY,
  name: "list_conversations",
  description:
    "List customer-support inbox conversations using state, assignee, time, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_conversations",
    direction: "input",
    description: "Conversation filters and pagination.",
    properties: {
      status: {
        type: "string",
        description: "Conversation state to match.",
        minLength: 1,
      },
      assigneeId: id("Provider identifier of the assigned agent or team."),
      updatedAfter: {
        type: "string",
        format: "date-time",
        description: "Return conversations updated at or after this timestamp.",
      },
      updatedBefore: {
        type: "string",
        format: "date-time",
        description: "Return conversations updated before this timestamp.",
      },
      pageSize: pageSizeProperty("conversations"),
      pageToken: pageTokenProperty("conversation"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_conversations",
    direction: "output",
    description: "One page of normalized support conversations.",
    required: ["conversations"],
    properties: {
      conversations: {
        type: "array",
        description: "Conversations in provider order.",
        items: conversationSchema(),
      },
      nextPageToken: nextPageTokenProperty("conversations"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getConversation = defineContract({
  capability: CAPABILITY,
  name: "get_conversation",
  description:
    "Retrieve one support conversation and its normalized message history.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_conversation",
    direction: "input",
    description: "Identifier of the conversation to retrieve.",
    required: ["conversationId"],
    properties: {
      conversationId: id("Provider identifier of the conversation."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_conversation",
    direction: "output",
    description: "The requested conversation and message history.",
    required: ["conversation", "messages"],
    properties: {
      conversation: conversationSchema(),
      messages: {
        type: "array",
        description: "Conversation messages in provider order.",
        items: messageSchema(),
      },
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const sendConversationReply = defineContract({
  capability: CAPABILITY,
  name: "send_conversation_reply",
  description:
    "Reply to a support inbox conversation as the connected workspace. This creates externally visible conversation history.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_conversation_reply",
    direction: "input",
    description:
      "Conversation, message content, visibility, and optional author.",
    required: ["conversationId", "body"],
    properties: {
      conversationId: id("Provider identifier of the conversation."),
      body: {
        type: "string",
        description: "Plain-text reply content.",
        minLength: 1,
      },
      public: {
        type: "boolean",
        description: "Whether the requester can see the reply.",
        default: true,
      },
      authorId: id("Provider identifier of the reply author."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_conversation_reply",
    direction: "output",
    description: "The newly created conversation reply.",
    required: ["message"],
    properties: { message: messageSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

export const supportCapabilityContracts = deepFreeze([
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  addTicketReply,
  assignTicket,
  listConversations,
  getConversation,
  sendConversationReply,
] as const satisfies readonly CapabilityToolContract[]);

type SupportContract = (typeof supportCapabilityContracts)[number];
type SupportContractsByName = {
  readonly [Contract in SupportContract as Contract["name"]]: Contract;
};

export const supportContractsByName = deepFreeze(
  Object.fromEntries(
    supportCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as SupportContractsByName,
);
