export * from "./email/index.js";
export * from "./http-client.js";
export * from "./messaging/index.js";

import { emailToolkitAdapters } from "./email/index.js";
import { messagingToolkitAdapters } from "./messaging/index.js";

/** Production adapters registered by the default executor. */
export const defaultToolkitAdapters = Object.freeze([
  ...emailToolkitAdapters,
  ...messagingToolkitAdapters,
]);
