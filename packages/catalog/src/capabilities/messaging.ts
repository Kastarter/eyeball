import type {
  CapabilityToolContract,
  JSONSchema202012,
  ObjectSchema202012,
} from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "messaging_chat" as const;
const VERSION = "1.0.0" as const;

function stagedAttachments(): JSONSchema202012 {
  return {
    type: "array",
    description: "Previously staged Eyeball files to attach to the message.",
    maxItems: 10,
    items: {
      type: "object",
      description: "A staged file reference that the provider can attach.",
      additionalProperties: false,
      required: ["fileId", "fileName"],
      properties: {
        fileId: {
          type: "string",
          description: "Eyeball identifier of the previously staged file.",
          minLength: 1,
        },
        fileName: {
          type: "string",
          description: "File name conversation members should see.",
          minLength: 1,
        },
        contentType: {
          type: "string",
          description: "MIME content type of the staged file when known.",
          minLength: 1,
        },
      },
    },
  };
}

function attachmentMetadata(): JSONSchema202012 {
  return {
    type: "array",
    description: "Metadata for files attached to the message.",
    items: {
      type: "object",
      description: "Metadata identifying one message attachment.",
      additionalProperties: false,
      required: ["attachmentId", "fileName"],
      properties: {
        attachmentId: {
          type: "string",
          description: "Provider-stable identifier for the attachment.",
          minLength: 1,
        },
        fileName: {
          type: "string",
          description: "Attachment file name shown in the conversation.",
          minLength: 1,
        },
        contentType: {
          type: "string",
          description: "MIME content type reported for the attachment.",
          minLength: 1,
        },
        url: {
          type: "string",
          format: "uri",
          description:
            "Provider URL for the attachment when the connection can access it.",
        },
      },
    },
  };
}

function senderSchema(): JSONSchema202012 {
  return {
    type: "object",
    description:
      "Normalized identity of the member or bot that sent the message.",
    additionalProperties: false,
    required: ["memberId", "displayName"],
    properties: {
      memberId: {
        type: "string",
        description: "Provider identifier of the sender.",
        minLength: 1,
      },
      displayName: {
        type: "string",
        description: "Human-readable sender name at retrieval time.",
        minLength: 1,
      },
      handle: {
        type: "string",
        description: "Provider handle or username when available.",
        minLength: 1,
      },
      isBot: {
        type: "boolean",
        description:
          "Whether the sender is represented as a bot or application account.",
      },
    },
  };
}

function reactionsSchema(): JSONSchema202012 {
  return {
    type: "array",
    description: "Aggregated reactions currently attached to the message.",
    items: {
      type: "object",
      description: "One reaction value and its current aggregate count.",
      additionalProperties: false,
      required: ["reaction", "count"],
      properties: {
        reaction: {
          type: "string",
          description:
            "Provider-supported emoji, shortcode, or reaction identifier.",
          minLength: 1,
        },
        count: {
          type: "integer",
          description: "Number of members who applied this reaction.",
          minimum: 0,
        },
        reactedByConnection: {
          type: "boolean",
          description:
            "Whether the connected bot or account applied this reaction.",
        },
      },
    },
  };
}

function messageSummarySchema(): JSONSchema202012 {
  return {
    type: "object",
    description:
      "Normalized content and metadata for one conversation message.",
    additionalProperties: false,
    required: ["messageId", "conversationId", "sender", "text", "sentAt"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the message.",
        minLength: 1,
      },
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the channel, room, group, chat, or direct conversation.",
        minLength: 1,
      },
      sender: senderSchema(),
      text: {
        type: "string",
        description:
          "Normalized plain-text representation of the message content.",
      },
      sentAt: {
        type: "string",
        format: "date-time",
        description: "RFC 3339 timestamp when the message was sent.",
      },
      editedAt: {
        type: "string",
        format: "date-time",
        description:
          "RFC 3339 timestamp of the latest edit when the message was edited.",
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the containing thread when applicable.",
        minLength: 1,
      },
      replyToMessageId: {
        type: "string",
        description:
          "Provider identifier of the directly referenced parent message.",
        minLength: 1,
      },
      reactions: reactionsSchema(),
    },
  };
}

function sentMessageOutputSchema(
  tool: string,
  description: string,
  parentField = false,
): ObjectSchema202012 {
  return publishedObjectSchema({
    capability: CAPABILITY,
    tool,
    direction: "output",
    description,
    required: [
      "messageId",
      "conversationId",
      ...(parentField ? ["parentMessageId"] : []),
      "sentAt",
    ],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the created message.",
        minLength: 1,
      },
      conversationId: {
        type: "string",
        description: "Provider identifier of the destination conversation.",
        minLength: 1,
      },
      ...(parentField
        ? {
            parentMessageId: {
              type: "string",
              description:
                "Provider identifier of the message that received the reply.",
              minLength: 1,
            },
          }
        : {}),
      sentAt: {
        type: "string",
        format: "date-time",
        description:
          "RFC 3339 timestamp when the provider accepted or sent the message.",
      },
    },
  });
}

const sendMessage = defineContract({
  capability: CAPABILITY,
  name: "send_message",
  description:
    "Send a new message to a channel, room, group, chat, or direct conversation. Use reply_to_message when preserving a specific thread or reply relationship matters; verify the destination and content before sending.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_message",
    direction: "input",
    description:
      "Destination conversation, message content, and optional staged attachments.",
    required: ["conversationId", "text"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the destination channel, room, group, chat, or direct conversation.",
        minLength: 1,
      },
      text: {
        type: "string",
        description:
          "Complete message text in the provider's supported plain-text or markup syntax.",
        minLength: 1,
      },
      replyToMessageId: {
        type: "string",
        description:
          "Optional parent message identifier when sending into a thread without strict reply semantics.",
        minLength: 1,
      },
      attachments: stagedAttachments(),
    },
  }),
  outputSchema: sentMessageOutputSchema(
    "send_message",
    "Provider identifiers and send timestamp for the newly created message.",
  ),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const listChannels = defineContract({
  capability: CAPABILITY,
  name: "list_channels",
  description:
    "List channels, rooms, groups, chats, or direct conversations visible to the connected account or bot. Use this to discover conversation identifiers before listing members or messages.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_channels",
    direction: "input",
    description:
      "Workspace scope, conversation filters, and pagination for channel discovery.",
    properties: {
      workspaceId: {
        type: "string",
        description:
          "Provider workspace, guild, team, or account identifier when the connection spans more than one.",
        minLength: 1,
      },
      types: {
        type: "array",
        description:
          "Conversation types to include; omit to include every visible type.",
        items: {
          type: "string",
          description: "Portable conversation type selector.",
          enum: ["public", "private", "direct", "group"],
        },
      },
      includeArchived: {
        type: "boolean",
        description: "Whether to include archived or inactive conversations.",
        default: false,
      },
      pageSize: pageSizeProperty("channels"),
      pageToken: pageTokenProperty("channel"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_channels",
    direction: "output",
    description:
      "One page of normalized conversations and an optional continuation token.",
    required: ["channels"],
    properties: {
      channels: {
        type: "array",
        description:
          "Channels, rooms, groups, chats, or direct conversations visible to the connection.",
        items: {
          type: "object",
          description: "Normalized metadata for one visible conversation.",
          additionalProperties: false,
          required: ["conversationId", "name", "type", "archived"],
          properties: {
            conversationId: {
              type: "string",
              description: "Provider identifier of the conversation.",
              minLength: 1,
            },
            name: {
              type: "string",
              description:
                "Human-readable conversation name or participant label.",
            },
            type: {
              type: "string",
              description: "Portable classification of the conversation.",
              enum: ["public", "private", "direct", "group"],
            },
            topic: {
              type: "string",
              description: "Current channel or room topic when supported.",
            },
            memberCount: {
              type: "integer",
              description:
                "Number of known conversation members when the provider exposes it.",
              minimum: 0,
            },
            archived: {
              type: "boolean",
              description: "Whether the conversation is archived or inactive.",
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("channels"),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const listMessages = defineContract({
  capability: CAPABILITY,
  name: "list_messages",
  description:
    "List recent messages in a channel, room, group, chat, or direct conversation with portable time filters and pagination. Use get_message when full metadata for one known message is needed.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_messages",
    direction: "input",
    description:
      "Conversation identifier, time range, reply inclusion, and pagination for listing messages.",
    required: ["conversationId"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the conversation whose messages should be listed.",
        minLength: 1,
      },
      sentAfter: {
        type: "string",
        format: "date-time",
        description:
          "Return messages sent at or after this RFC 3339 timestamp.",
      },
      sentBefore: {
        type: "string",
        format: "date-time",
        description: "Return messages sent before this RFC 3339 timestamp.",
      },
      includeThreadReplies: {
        type: "boolean",
        description:
          "Whether to include thread replies in addition to top-level messages.",
        default: false,
      },
      pageSize: pageSizeProperty("messages"),
      pageToken: pageTokenProperty("message"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_messages",
    direction: "output",
    description:
      "One page of normalized conversation messages and an optional continuation token.",
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        description: "Messages in provider-defined conversation order.",
        items: messageSummarySchema(),
      },
      nextPageToken: nextPageTokenProperty("messages"),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const getMessage = defineContract({
  capability: CAPABILITY,
  name: "get_message",
  description:
    "Retrieve one message and its normalized sender, content, thread, attachment, and reaction metadata. Use this after obtaining both the conversation and message identifiers.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_message",
    direction: "input",
    description:
      "Conversation and message identifiers for one provider message.",
    required: ["conversationId", "messageId"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the conversation containing the message.",
        minLength: 1,
      },
      messageId: {
        type: "string",
        description: "Provider identifier of the message to retrieve.",
        minLength: 1,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_message",
    direction: "output",
    description:
      "Normalized content and metadata for one conversation message.",
    required: ["messageId", "conversationId", "sender", "text", "sentAt"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the message.",
        minLength: 1,
      },
      conversationId: {
        type: "string",
        description: "Provider identifier of the containing conversation.",
        minLength: 1,
      },
      sender: senderSchema(),
      text: {
        type: "string",
        description:
          "Normalized plain-text representation of the message content.",
      },
      rawMarkup: {
        type: "string",
        description:
          "Original provider markup when it differs materially from normalized text.",
      },
      sentAt: {
        type: "string",
        format: "date-time",
        description: "RFC 3339 timestamp when the message was sent.",
      },
      editedAt: {
        type: "string",
        format: "date-time",
        description:
          "RFC 3339 timestamp of the latest edit when the message was edited.",
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the containing thread when applicable.",
        minLength: 1,
      },
      replyToMessageId: {
        type: "string",
        description:
          "Provider identifier of the directly referenced parent message.",
        minLength: 1,
      },
      attachments: attachmentMetadata(),
      reactions: reactionsSchema(),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const replyToMessage = defineContract({
  capability: CAPABILITY,
  name: "reply_to_message",
  description:
    "Reply to a specific message while preserving the provider's thread or reply relationship. Use send_message for a new top-level message; this sends content visible to conversation members.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "reply_to_message",
    direction: "input",
    description:
      "Conversation, parent message, reply text, and optional staged attachments.",
    required: ["conversationId", "messageId", "text"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the conversation containing the parent message.",
        minLength: 1,
      },
      messageId: {
        type: "string",
        description: "Provider identifier of the message being replied to.",
        minLength: 1,
      },
      text: {
        type: "string",
        description:
          "Complete reply text in the provider's supported plain-text or markup syntax.",
        minLength: 1,
      },
      attachments: stagedAttachments(),
    },
  }),
  outputSchema: sentMessageOutputSchema(
    "reply_to_message",
    "Provider identifiers and send timestamp for the newly created reply.",
    true,
  ),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const addReaction = defineContract({
  capability: CAPABILITY,
  name: "add_reaction",
  description:
    "Add an emoji or provider-supported reaction to an existing message as the connected account or bot. Repeating the same reaction has no additional effect on providers that allow only one reaction per actor.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_reaction",
    direction: "input",
    description: "Conversation, message, and reaction value to apply.",
    required: ["conversationId", "messageId", "reaction"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the conversation containing the message.",
        minLength: 1,
      },
      messageId: {
        type: "string",
        description:
          "Provider identifier of the message receiving the reaction.",
        minLength: 1,
      },
      reaction: {
        type: "string",
        description:
          "Provider-supported emoji, shortcode, or reaction identifier to add.",
        minLength: 1,
        maxLength: 128,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_reaction",
    direction: "output",
    description: "Result of applying the reaction to the target message.",
    required: ["messageId", "reaction", "added"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the reacted-to message.",
        minLength: 1,
      },
      reaction: {
        type: "string",
        description:
          "Provider-normalized emoji, shortcode, or reaction identifier.",
        minLength: 1,
      },
      added: {
        type: "boolean",
        description:
          "Whether the requested reaction is now applied by the connection.",
      },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

const createChannel = defineContract({
  capability: CAPABILITY,
  name: "create_channel",
  description:
    "Create a channel, room, or group where the connected account or bot has permission. This changes shared workspace state and may notify or expose content to invited members.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_channel",
    direction: "input",
    description:
      "Workspace destination, channel identity, visibility, topic, and initial members.",
    required: ["name"],
    properties: {
      workspaceId: {
        type: "string",
        description:
          "Provider workspace, guild, team, or account identifier in which to create the channel.",
        minLength: 1,
      },
      name: {
        type: "string",
        description: "Human-readable channel, room, or group name.",
        minLength: 1,
        maxLength: 100,
      },
      visibility: {
        type: "string",
        description:
          "Whether the new conversation is discoverable publicly or limited to invited members.",
        enum: ["public", "private"],
        default: "public",
      },
      topic: {
        type: "string",
        description: "Initial channel or room topic when supported.",
        maxLength: 1024,
      },
      memberIds: {
        type: "array",
        description:
          "Provider member identifiers to invite when creating the conversation.",
        uniqueItems: true,
        items: {
          type: "string",
          description: "Provider identifier of an initial conversation member.",
          minLength: 1,
        },
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_channel",
    direction: "output",
    description:
      "Provider identity and normalized attributes of the newly created conversation.",
    required: ["conversationId", "name", "visibility", "createdAt"],
    properties: {
      conversationId: {
        type: "string",
        description:
          "Provider identifier of the newly created channel, room, or group.",
        minLength: 1,
      },
      name: {
        type: "string",
        description: "Provider-normalized conversation name.",
        minLength: 1,
      },
      visibility: {
        type: "string",
        description: "Effective visibility of the newly created conversation.",
        enum: ["public", "private"],
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description:
          "RFC 3339 timestamp when the provider created the conversation.",
      },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: VERSION,
});

const listMembers = defineContract({
  capability: CAPABILITY,
  name: "list_members",
  description:
    "List members visible to the connection, optionally scoped to a workspace or conversation. Use returned member identifiers for invitations, mentions, or direct-conversation workflows.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_members",
    direction: "input",
    description:
      "Optional workspace or conversation scope and pagination for member discovery.",
    properties: {
      workspaceId: {
        type: "string",
        description:
          "Provider workspace, guild, team, or account identifier to scope the member list.",
        minLength: 1,
      },
      conversationId: {
        type: "string",
        description:
          "Provider conversation identifier to list only members of that channel, room, group, or chat.",
        minLength: 1,
      },
      pageSize: pageSizeProperty("members"),
      pageToken: pageTokenProperty("member"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_members",
    direction: "output",
    description:
      "One page of normalized member identities and an optional continuation token.",
    required: ["members"],
    properties: {
      members: {
        type: "array",
        description:
          "Members visible in the requested workspace or conversation scope.",
        items: {
          type: "object",
          description:
            "Normalized identity and status for one workspace or conversation member.",
          additionalProperties: false,
          required: ["memberId", "displayName", "isBot"],
          properties: {
            memberId: {
              type: "string",
              description: "Provider identifier of the member.",
              minLength: 1,
            },
            displayName: {
              type: "string",
              description: "Human-readable member name at retrieval time.",
              minLength: 1,
            },
            handle: {
              type: "string",
              description: "Provider handle or username when available.",
              minLength: 1,
            },
            email: {
              type: "string",
              format: "email",
              description:
                "Member email address when visible to the connection.",
            },
            role: {
              type: "string",
              description: "Provider-normalized role label when available.",
              minLength: 1,
            },
            isBot: {
              type: "boolean",
              description:
                "Whether the member is represented as a bot or application account.",
            },
            status: {
              type: "string",
              description:
                "Provider-normalized membership or presence status when available.",
              minLength: 1,
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("members"),
    },
  }),
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: VERSION,
});

export const messagingCapabilityContracts = deepFreeze([
  sendMessage,
  listChannels,
  listMessages,
  getMessage,
  replyToMessage,
  addReaction,
  createChannel,
  listMembers,
] as const satisfies readonly CapabilityToolContract[]);

type MessagingContract = (typeof messagingCapabilityContracts)[number];
type MessagingContractsByName = {
  readonly [Contract in MessagingContract as Contract["name"]]: Contract;
};

export const messagingContractsByName = deepFreeze(
  Object.fromEntries(
    messagingCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as MessagingContractsByName,
);
