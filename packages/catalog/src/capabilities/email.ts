import type {
  CapabilityToolContract,
  JSONSchema202012,
  JSONSchemaObject202012,
  ObjectSchema202012,
  SemVer,
} from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "email" as const;
const VERSION = "1.0.0" as const;
const STAGED_ATTACHMENT_VERSION = "1.1.0" as const;

function emailArray(description: string): JSONSchemaObject202012 {
  return {
    type: "array",
    description,
    items: {
      type: "string",
      format: "email",
      description: "A syntactically valid email address.",
    },
  };
}

function stagedAttachments(): JSONSchema202012 {
  return {
    type: "array",
    description: "Previously staged Eyeball files to attach.",
    maxItems: 25,
    items: {
      description: "A staged file reference that the provider can attach.",
      anyOf: [
        {
          type: "object",
          description: "Preferred staged-file reference shape.",
          additionalProperties: false,
          required: ["fileId"],
          properties: {
            fileId: {
              type: "string",
              description:
                "Eyeball file_* identifier returned by POST /v1/files.",
              pattern: "^file_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
            },
            name: {
              type: "string",
              description:
                "Optional recipient-visible name overriding staged metadata.",
              minLength: 1,
            },
            mimeType: {
              type: "string",
              description:
                "Optional MIME type overriding staged metadata for delivery.",
              minLength: 1,
            },
          },
        },
        {
          type: "object",
          description:
            "Deprecated 1.0 staged-file reference retained for compatibility.",
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
              description:
                "Deprecated recipient-visible name; use name in new calls.",
              minLength: 1,
            },
            contentType: {
              type: "string",
              description: "Deprecated MIME type; use mimeType in new calls.",
              minLength: 1,
            },
          },
        },
      ],
    },
  };
}

function attachmentMetadata(): JSONSchema202012 {
  return {
    type: "array",
    description:
      "Metadata for files attached to the email; file content is not included.",
    items: {
      type: "object",
      description: "Metadata identifying one email attachment.",
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
          description: "Original attachment file name.",
          minLength: 1,
        },
        contentType: {
          type: "string",
          description: "MIME content type reported for the attachment.",
          minLength: 1,
        },
        sizeBytes: {
          type: "integer",
          description:
            "Attachment size in bytes when reported by the provider.",
          minimum: 0,
        },
      },
    },
  };
}

function bodyProperty(): JSONSchema202012 {
  return {
    type: "string",
    description: "Complete body in the format selected by bodyFormat.",
    minLength: 1,
  };
}

function bodyFormatProperty(): JSONSchema202012 {
  return {
    type: "string",
    description: "Serialization format of the body content.",
    enum: ["text", "html"],
    default: "text",
  };
}

function deliveryOutputSchema(
  tool: string,
  description: string,
  version: SemVer = VERSION,
): ObjectSchema202012 {
  return publishedObjectSchema({
    capability: CAPABILITY,
    tool,
    direction: "output",
    version,
    description,
    required: ["messageId", "acceptedRecipients"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the created email message.",
        minLength: 1,
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the conversation thread when available.",
        minLength: 1,
      },
      acceptedRecipients: emailArray(
        "Recipient addresses accepted by the provider for delivery.",
      ),
    },
  });
}

function emailSummarySchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "Compact mailbox metadata for one email message.",
    additionalProperties: false,
    required: [
      "messageId",
      "from",
      "to",
      "subject",
      "receivedAt",
      "unread",
      "hasAttachments",
    ],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the email message.",
        minLength: 1,
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the containing conversation thread.",
        minLength: 1,
      },
      from: {
        type: "string",
        format: "email",
        description: "Sender email address.",
      },
      to: emailArray("Primary recipient email addresses."),
      subject: {
        type: "string",
        description: "Email subject exactly as stored by the provider.",
      },
      snippet: {
        type: "string",
        description: "Short provider-generated preview of the email body.",
      },
      receivedAt: {
        type: "string",
        format: "date-time",
        description: "RFC 3339 timestamp when the mailbox received the email.",
      },
      unread: {
        type: "boolean",
        description: "Whether the email is currently marked unread.",
      },
      hasAttachments: {
        type: "boolean",
        description: "Whether the email includes at least one attachment.",
      },
      labelIds: {
        type: "array",
        description:
          "Provider label, category, or folder identifiers on the email.",
        items: {
          type: "string",
          description:
            "Provider identifier of an applied label, category, or folder.",
          minLength: 1,
        },
      },
    },
  };
}

const sendEmail = defineContract({
  capability: CAPABILITY,
  name: "send_email",
  description:
    "Send a new email from the connected email account. Use this for a new conversation, not a reply to an existing message or thread. This sends content to external recipients; verify recipients, subject, and body first.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_email",
    direction: "input",
    version: STAGED_ATTACHMENT_VERSION,
    description: "Recipients, content, and staged attachments for a new email.",
    required: ["to", "subject", "body"],
    properties: {
      to: {
        ...emailArray("Primary recipient email addresses."),
        minItems: 1,
      },
      cc: emailArray("Carbon-copy recipient email addresses."),
      bcc: emailArray("Blind-carbon-copy recipient email addresses."),
      subject: {
        type: "string",
        description: "Subject line shown to recipients.",
        minLength: 1,
        maxLength: 998,
      },
      body: bodyProperty(),
      bodyFormat: bodyFormatProperty(),
      replyTo: {
        type: "string",
        format: "email",
        description:
          "Address recipients should use when replying instead of the sender.",
      },
      attachments: stagedAttachments(),
    },
  }),
  outputSchema: deliveryOutputSchema(
    "send_email",
    "Identifiers and accepted recipients for the newly sent email.",
    STAGED_ATTACHMENT_VERSION,
  ),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: STAGED_ATTACHMENT_VERSION,
});

const listEmails = defineContract({
  capability: CAPABILITY,
  name: "list_emails",
  description:
    "List email messages from a mailbox, folder, or label with portable filters and pagination. Use this to browse messages; use search_emails when a provider query expression is the primary selector.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_emails",
    direction: "input",
    description:
      "Mailbox location, filters, and pagination for listing email messages.",
    properties: {
      mailboxId: {
        type: "string",
        description:
          "Mailbox identifier; omit to use the connected account's default mailbox.",
        minLength: 1,
      },
      folderId: {
        type: "string",
        description: "Folder identifier used to restrict the mailbox listing.",
        minLength: 1,
      },
      labelIds: {
        type: "array",
        description: "Labels or categories every returned email should have.",
        items: {
          type: "string",
          description: "Provider label or category identifier.",
          minLength: 1,
        },
      },
      from: {
        type: "string",
        format: "email",
        description: "Return only emails from this sender address.",
      },
      to: {
        type: "string",
        format: "email",
        description: "Return only emails addressed to this recipient.",
      },
      subject: {
        type: "string",
        description: "Case-insensitive subject text to match.",
        minLength: 1,
      },
      receivedAfter: {
        type: "string",
        format: "date-time",
        description:
          "Return emails received at or after this RFC 3339 timestamp.",
      },
      receivedBefore: {
        type: "string",
        format: "date-time",
        description: "Return emails received before this RFC 3339 timestamp.",
      },
      unreadOnly: {
        type: "boolean",
        description: "When true, return only unread emails.",
        default: false,
      },
      hasAttachments: {
        type: "boolean",
        description:
          "When supplied, filter by whether an email has attachments.",
      },
      pageSize: pageSizeProperty("emails"),
      pageToken: pageTokenProperty("email"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_emails",
    direction: "output",
    description:
      "One page of email summaries and an optional continuation token.",
    required: ["emails"],
    properties: {
      emails: {
        type: "array",
        description: "Email summaries in provider-defined mailbox order.",
        items: emailSummarySchema(),
      },
      nextPageToken: nextPageTokenProperty("emails"),
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

const getEmail = defineContract({
  capability: CAPABILITY,
  name: "get_email",
  description:
    "Retrieve one email message with normalized headers, body, labels, and attachment metadata. Use this after obtaining a message identifier; it does not download attachment content.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_email",
    direction: "input",
    description: "Identifier and content-selection options for one email.",
    required: ["messageId"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the email message to retrieve.",
        minLength: 1,
      },
      includeBody: {
        type: "boolean",
        description:
          "Whether to include the normalized message body in the response.",
        default: true,
      },
      includeAttachmentMetadata: {
        type: "boolean",
        description: "Whether to include attachment identifiers and metadata.",
        default: true,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_email",
    direction: "output",
    description: "Normalized content and metadata for one email message.",
    required: ["messageId", "from", "to", "subject", "receivedAt"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the email message.",
        minLength: 1,
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the containing conversation thread.",
        minLength: 1,
      },
      from: {
        type: "string",
        format: "email",
        description: "Sender email address.",
      },
      to: emailArray("Primary recipient email addresses."),
      cc: emailArray("Carbon-copy recipient email addresses."),
      bcc: emailArray(
        "Blind-carbon-copy recipient email addresses visible to the connection.",
      ),
      subject: {
        type: "string",
        description: "Email subject exactly as stored by the provider.",
      },
      sentAt: {
        type: "string",
        format: "date-time",
        description: "RFC 3339 timestamp supplied by the sender or provider.",
      },
      receivedAt: {
        type: "string",
        format: "date-time",
        description: "RFC 3339 timestamp when the mailbox received the email.",
      },
      body: {
        type: "object",
        description:
          "Normalized email body when includeBody is true and content is available.",
        additionalProperties: false,
        required: ["format", "content"],
        properties: {
          format: {
            type: "string",
            description: "Serialization format of the returned body.",
            enum: ["text", "html"],
          },
          content: {
            type: "string",
            description: "Complete normalized email body content.",
          },
        },
      },
      headers: {
        type: "array",
        description: "Ordered message headers exposed by the provider.",
        items: {
          type: "object",
          description: "One email header name and value.",
          additionalProperties: false,
          required: ["name", "value"],
          properties: {
            name: {
              type: "string",
              description: "Case-preserving email header name.",
              minLength: 1,
            },
            value: {
              type: "string",
              description: "Unfolded email header value.",
            },
          },
        },
      },
      attachments: attachmentMetadata(),
      labelIds: {
        type: "array",
        description:
          "Provider label, category, or folder identifiers on the email.",
        items: {
          type: "string",
          description:
            "Provider identifier of an applied label, category, or folder.",
          minLength: 1,
        },
      },
      draft: {
        type: "boolean",
        description: "Whether the retrieved message is an unsent draft.",
      },
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

const replyToEmail = defineContract({
  capability: CAPABILITY,
  name: "reply_to_email",
  description:
    "Reply within an existing email message or conversation thread. Use this instead of send_email when preserving reply headers and thread context matters; verify reply-all recipients before sending.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "reply_to_email",
    direction: "input",
    version: STAGED_ATTACHMENT_VERSION,
    description:
      "Target message, reply content, recipient behavior, and staged attachments.",
    required: ["messageId", "body"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the email being replied to.",
        minLength: 1,
      },
      body: bodyProperty(),
      bodyFormat: bodyFormatProperty(),
      replyAll: {
        type: "boolean",
        description:
          "When true, include the original sender and recipients supported by the provider.",
        default: false,
      },
      to: emailArray(
        "Explicit primary reply recipients, overriding provider-derived recipients.",
      ),
      cc: emailArray("Explicit carbon-copy reply recipients."),
      bcc: emailArray("Explicit blind-carbon-copy reply recipients."),
      attachments: stagedAttachments(),
    },
  }),
  outputSchema: deliveryOutputSchema(
    "reply_to_email",
    "Identifiers and accepted recipients for the sent reply.",
    STAGED_ATTACHMENT_VERSION,
  ),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: STAGED_ATTACHMENT_VERSION,
});

const createDraft = defineContract({
  capability: CAPABILITY,
  name: "create_draft",
  description:
    "Create an unsent email draft in the connected mailbox. Use this when a person or later workflow should review or send the content; this does not deliver a message to recipients.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_draft",
    direction: "input",
    version: STAGED_ATTACHMENT_VERSION,
    description:
      "Recipients, content, and staged attachments to save as an email draft.",
    required: ["body"],
    properties: {
      to: emailArray("Primary recipient email addresses saved on the draft."),
      cc: emailArray(
        "Carbon-copy recipient email addresses saved on the draft.",
      ),
      bcc: emailArray(
        "Blind-carbon-copy recipient email addresses saved on the draft.",
      ),
      subject: {
        type: "string",
        description: "Subject line saved on the draft.",
        maxLength: 998,
      },
      body: bodyProperty(),
      bodyFormat: bodyFormatProperty(),
      replyTo: {
        type: "string",
        format: "email",
        description:
          "Address recipients should use if the draft is later sent and replied to.",
      },
      attachments: stagedAttachments(),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_draft",
    direction: "output",
    version: STAGED_ATTACHMENT_VERSION,
    description: "Provider identifiers for the newly created unsent draft.",
    required: ["draftId"],
    properties: {
      draftId: {
        type: "string",
        description: "Provider identifier of the created draft resource.",
        minLength: 1,
      },
      messageId: {
        type: "string",
        description:
          "Provider message identifier associated with the draft when available.",
        minLength: 1,
      },
      threadId: {
        type: "string",
        description:
          "Provider identifier of the conversation thread when available.",
        minLength: 1,
      },
    },
  }),
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: STAGED_ATTACHMENT_VERSION,
});

const searchEmails = defineContract({
  capability: CAPABILITY,
  name: "search_emails",
  description:
    "Search mailbox content using a provider-supported query expression and return normalized email summaries. Use this for full-text or provider query syntax; query portability depends on the connected provider.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_emails",
    direction: "input",
    description: "Mailbox query and pagination for an email search.",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description:
          "Provider-supported mailbox search expression or full-text query.",
        minLength: 1,
      },
      mailboxId: {
        type: "string",
        description:
          "Mailbox identifier; omit to search the connected account's default mailbox.",
        minLength: 1,
      },
      folderId: {
        type: "string",
        description:
          "Folder identifier used to restrict the search when supported.",
        minLength: 1,
      },
      pageSize: pageSizeProperty("email search results"),
      pageToken: pageTokenProperty("email search result"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_emails",
    direction: "output",
    description:
      "One page of matching email summaries and an optional continuation token.",
    required: ["emails"],
    properties: {
      emails: {
        type: "array",
        description: "Email summaries matching the provider query.",
        items: emailSummarySchema(),
      },
      nextPageToken: nextPageTokenProperty("email search results"),
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

const listThreads = defineContract({
  capability: CAPABILITY,
  name: "list_threads",
  description:
    "List email conversation threads and their latest state with portable filters and pagination. Use this when conversation grouping is more useful than individual message rows.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_threads",
    direction: "input",
    description:
      "Mailbox filters and pagination for listing conversation threads.",
    properties: {
      mailboxId: {
        type: "string",
        description:
          "Mailbox identifier; omit to use the connected account's default mailbox.",
        minLength: 1,
      },
      labelIds: {
        type: "array",
        description: "Labels or categories every returned thread should have.",
        items: {
          type: "string",
          description: "Provider label or category identifier.",
          minLength: 1,
        },
      },
      participantAddresses: emailArray(
        "Return threads containing at least one of these participant addresses.",
      ),
      receivedAfter: {
        type: "string",
        format: "date-time",
        description:
          "Return threads updated at or after this RFC 3339 timestamp.",
      },
      receivedBefore: {
        type: "string",
        format: "date-time",
        description: "Return threads updated before this RFC 3339 timestamp.",
      },
      unreadOnly: {
        type: "boolean",
        description:
          "When true, return only threads containing unread messages.",
        default: false,
      },
      pageSize: pageSizeProperty("threads"),
      pageToken: pageTokenProperty("thread"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_threads",
    direction: "output",
    description:
      "One page of normalized conversation threads and an optional continuation token.",
    required: ["threads"],
    properties: {
      threads: {
        type: "array",
        description: "Conversation threads in provider-defined mailbox order.",
        items: {
          type: "object",
          description:
            "Summary and latest state for one email conversation thread.",
          additionalProperties: false,
          required: [
            "threadId",
            "participantAddresses",
            "messageCount",
            "latestMessageAt",
            "unread",
          ],
          properties: {
            threadId: {
              type: "string",
              description: "Provider identifier of the conversation thread.",
              minLength: 1,
            },
            subject: {
              type: "string",
              description:
                "Most representative or latest subject for the thread.",
            },
            participantAddresses: emailArray(
              "Distinct email addresses participating in the thread.",
            ),
            messageCount: {
              type: "integer",
              description: "Number of messages currently in the thread.",
              minimum: 1,
            },
            latestMessageAt: {
              type: "string",
              format: "date-time",
              description:
                "RFC 3339 timestamp of the latest message in the thread.",
            },
            snippet: {
              type: "string",
              description:
                "Short provider-generated preview of the latest thread content.",
            },
            unread: {
              type: "boolean",
              description:
                "Whether the thread contains at least one unread message.",
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("threads"),
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

const addEmailLabel = defineContract({
  capability: CAPABILITY,
  name: "add_email_label",
  description:
    "Apply a label, category, or destination folder to an existing email message. Use this to organize mail without changing its content; repeating the same operation has no additional effect.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_email_label",
    direction: "input",
    description:
      "Target email and label, category, or folder operation to apply.",
    required: ["messageId", "labelId"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the email message to update.",
        minLength: 1,
      },
      labelId: {
        type: "string",
        description:
          "Provider identifier or exact name of the label, category, or folder.",
        minLength: 1,
      },
      operation: {
        type: "string",
        description:
          "Whether to add a label/category or move the email to a folder.",
        enum: ["add", "move"],
        default: "add",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_email_label",
    direction: "output",
    description:
      "Result of applying the requested mailbox organization operation.",
    required: ["messageId", "labelId", "applied"],
    properties: {
      messageId: {
        type: "string",
        description: "Provider identifier of the updated email message.",
        minLength: 1,
      },
      labelId: {
        type: "string",
        description:
          "Provider identifier or name of the applied label, category, or folder.",
        minLength: 1,
      },
      applied: {
        type: "boolean",
        description:
          "Whether the requested organization state is now in effect.",
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

export const emailCapabilityContracts = deepFreeze([
  sendEmail,
  listEmails,
  getEmail,
  replyToEmail,
  createDraft,
  searchEmails,
  listThreads,
  addEmailLabel,
] as const satisfies readonly CapabilityToolContract[]);

type EmailContract = (typeof emailCapabilityContracts)[number];
type EmailContractsByName = {
  readonly [Contract in EmailContract as Contract["name"]]: Contract;
};

export const emailContractsByName = deepFreeze(
  Object.fromEntries(
    emailCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as EmailContractsByName,
);
