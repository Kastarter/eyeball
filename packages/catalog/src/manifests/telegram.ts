import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const telegramManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "telegram",
    displayName: "Telegram Bot",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.telegram.org",
    baseUrlOverrideEnv: "EYEBALL_TELEGRAM_BASE_URL",
  },
  implements: [
    {
      capability: "messaging_chat",
      canonicalTool: "send_message",
      canonicalVersion: "1.0.0",
      operationId: "sendMessage",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "list_messages",
      canonicalVersion: "1.0.0",
      operationId: "getUpdates",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "get_message",
      canonicalVersion: "1.0.0",
      operationId: "getUpdates.lookup",
    },
    {
      capability: "messaging_chat",
      canonicalTool: "reply_to_message",
      canonicalVersion: "1.0.0",
      operationId: "sendMessage.reply",
    },
  ],
} as const satisfies ProviderManifest);
