import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const discordManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "discord",
    displayName: "Discord",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://discord.com",
    baseUrlOverrideEnv: "EYEBALL_DISCORD_BASE_URL",
  },
  implements: [
    {
      capability: "messaging_chat",
      canonicalTool: "send_message",
      canonicalVersion: "1.0.0",
      operationId: "channels.messages.create",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_channels",
      canonicalVersion: "1.0.0",
      operationId: "guilds.channels.list",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_messages",
      canonicalVersion: "1.0.0",
      operationId: "channels.messages.list",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "get_message",
      canonicalVersion: "1.0.0",
      operationId: "channels.messages.get",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "reply_to_message",
      canonicalVersion: "1.0.0",
      operationId: "channels.messages.reply",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "add_reaction",
      canonicalVersion: "1.0.0",
      operationId: "channels.messages.reactions.create",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "create_channel",
      canonicalVersion: "1.0.0",
      operationId: "guilds.channels.create",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_members",
      canonicalVersion: "1.0.0",
      operationId: "guilds.members.list",
    },
  ],
} as const satisfies ProviderManifest);
