import type { ToolkitAdapter } from "@eyeball/core";
import { discordAdapter } from "./discord.js";
import { slackAdapter } from "./slack.js";
import { telegramAdapter } from "./telegram.js";
import { whatsAppBusinessAdapter } from "./whatsapp-business.js";

export * from "./discord.js";
export * from "./slack.js";
export * from "./telegram.js";
export * from "./whatsapp-business.js";

/** Production messaging adapters shipped by the open-core runtime. */
export const messagingToolkitAdapters = Object.freeze([
  slackAdapter,
  discordAdapter,
  telegramAdapter,
  whatsAppBusinessAdapter,
] as const satisfies readonly ToolkitAdapter[]);
