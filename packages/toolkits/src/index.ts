export * from "./business/index.js";
export * from "./email/index.js";
export * from "./http-client.js";
export * from "./messaging/index.js";
export * from "./productivity/index.js";
export * from "./social-data/index.js";
export * from "./voice/index.js";

import { businessToolkitAdapters } from "./business/index.js";
import { emailToolkitAdapters } from "./email/index.js";
import { messagingToolkitAdapters } from "./messaging/index.js";
import { productivityToolkitAdapters } from "./productivity/index.js";
import { socialDataToolkitAdapters } from "./social-data/index.js";
import { voiceToolkitAdapters } from "./voice/index.js";

/** Production adapters registered by the default executor. */
export const defaultToolkitAdapters = Object.freeze([
  ...emailToolkitAdapters,
  ...messagingToolkitAdapters,
  ...voiceToolkitAdapters,
  ...businessToolkitAdapters,
  ...productivityToolkitAdapters,
  ...socialDataToolkitAdapters,
]);
