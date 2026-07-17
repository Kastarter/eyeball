import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const slackManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.1",
  toolkit: {
    slug: "slack",
    displayName: "Slack",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    optionalScopes: [
      "channels:history",
      "channels:manage",
      "channels:read",
      "chat:write",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "mpim:history",
      "mpim:read",
      "reactions:write",
      "users:read",
      "users:read.email",
    ],
  },
  endpoint: {
    baseUrl: "https://slack.com",
    baseUrlOverrideEnv: "EYEBALL_SLACK_BASE_URL",
  },
  implements: [
    {
      capability: "messaging_chat",
      canonicalTool: "send_message",
      canonicalVersion: "1.0.0",
      operationId: "chat.postMessage",
      requiredScopes: ["chat:write"],
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_channels",
      canonicalVersion: "1.0.0",
      operationId: "conversations.list",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_messages",
      canonicalVersion: "1.0.0",
      operationId: "conversations.history",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "get_message",
      canonicalVersion: "1.0.0",
      operationId: "conversations.replies",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "reply_to_message",
      canonicalVersion: "1.0.0",
      operationId: "chat.postMessage.thread",
      requiredScopes: ["chat:write"],
    },
    {
      capability: "messaging_chat",
      canonicalTool: "add_reaction",
      canonicalVersion: "1.0.0",
      operationId: "reactions.add",
      requiredScopes: ["reactions:write"],
    },
    {
      capability: "messaging_chat",
      canonicalTool: "create_channel",
      canonicalVersion: "1.0.0",
      operationId: "conversations.create",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_members",
      canonicalVersion: "1.0.0",
      operationId: "users.list",
    },
  ],
  triggers: [
    {
      capability: "messaging_chat",
      canonicalTrigger: "message_received",
      canonicalVersion: "1.0.0",
      operationId: "events_api.message",
      delivery: {
        mode: "push",
        providerEvent: "message",
      },
      requiredScopes: ["channels:history"],
      payloadExtensionSchema: {
        type: "object",
        additionalProperties: false,
        required: ["eventId", "teamId", "channelId", "eventTs"],
        properties: {
          eventId: { type: "string", minLength: 1 },
          teamId: { type: "string", minLength: 1 },
          channelId: { type: "string", minLength: 1 },
          eventTs: { type: "string", minLength: 1 },
          subtype: { type: "string", minLength: 1 },
        },
      },
    },
  ],
} as const satisfies ProviderManifest);
