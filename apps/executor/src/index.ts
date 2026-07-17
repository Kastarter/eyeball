export * from "./adapters/index.js";
export * from "./credential-provider.js";
export * from "./dev-vault.js";
export * from "./dev-voice-sessions.js";
export * from "./engine.js";
export * from "./queue.js";
export * from "./routes.js";
export * from "./staged-files.js";
export * from "./store.js";
export * from "./triggers/index.js";
export * from "./webhooks/index.js";

import { createConfiguredCredentialProvider } from "./credential-provider.js";
import { ExecutionEngine } from "./engine.js";
import { createExecutorApp } from "./routes.js";
import { TriggerPollingScheduler } from "./triggers/service.js";

const env = process.env;
export const engine = new ExecutionEngine({
  env,
  credentialProvider: createConfiguredCredentialProvider({ env }),
});
export const triggerPollingScheduler = new TriggerPollingScheduler({
  service: engine.triggerService,
});
export const app = createExecutorApp({ engine });
