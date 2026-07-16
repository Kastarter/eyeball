import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const zendeskManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "zendesk",
    displayName: "Zendesk",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
  },
  endpoint: {
    baseUrl: "https://zendesk.invalid",
    baseUrlOverrideEnv: "EYEBALL_ZENDESK_BASE_URL",
  },
  implements: [
    {
      capability: "customer_support",
      canonicalTool: "create_ticket",
      canonicalVersion: "1.0.0",
      operationId: "tickets.create",
    },
    {
      capability: "customer_support",
      canonicalTool: "get_ticket",
      canonicalVersion: "1.0.0",
      operationId: "tickets.show",
    },
    {
      capability: "customer_support",
      canonicalTool: "list_tickets",
      canonicalVersion: "1.0.0",
      operationId: "tickets.list",
    },
    {
      capability: "customer_support",
      canonicalTool: "update_ticket",
      canonicalVersion: "1.0.0",
      operationId: "tickets.update",
    },
    {
      capability: "customer_support",
      canonicalTool: "add_ticket_reply",
      canonicalVersion: "1.0.0",
      operationId: "ticketComments.create",
    },
    {
      capability: "customer_support",
      canonicalTool: "assign_ticket",
      canonicalVersion: "1.0.0",
      operationId: "tickets.assign",
    },
    {
      capability: "customer_support",
      canonicalTool: "list_conversations",
      canonicalVersion: "1.0.0",
      operationId: "conversations.list",
    },
    {
      capability: "customer_support",
      canonicalTool: "get_conversation",
      canonicalVersion: "1.0.0",
      operationId: "conversations.show",
    },
    {
      capability: "customer_support",
      canonicalTool: "send_conversation_reply",
      canonicalVersion: "1.0.0",
      operationId: "conversations.replies.create",
    },
  ],
} as const satisfies ProviderManifest);
