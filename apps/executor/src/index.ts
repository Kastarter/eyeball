export * from "./adapters/index.js";
export * from "./api-key-authenticator.js";
export * from "./credential-provider.js";
export * from "./dev-vault.js";
export * from "./dev-voice-sessions.js";
export * from "./engine.js";
export * from "./queue.js";
export * from "./rate-limit.js";
export * from "./remote-credential-provider.js";
export * from "./routes.js";
export * from "./runtime.js";
export * from "./staged-files.js";
export * from "./store.js";
export * from "./stores/postgres/index.js";
export * from "./telemetry/index.js";
export * from "./triggers/index.js";
export * from "./usage/index.js";
export * from "./voice/index.js";
export * from "./voice-session-grants.js";
export * from "./webhooks/index.js";

import { createExecutorApp } from "./routes.js";
import { createExecutorRuntime } from "./runtime.js";

const env = process.env;
export const executorRuntime = await createExecutorRuntime({ env });
export const engine = executorRuntime.engine;
export const triggerPollingScheduler = executorRuntime.triggerPollingScheduler;
export const app = createExecutorApp({
  engine,
  apiKeyAuthenticator: executorRuntime.apiKeyAuthenticator,
  ...(executorRuntime.voiceSessionGrantVerifier === undefined
    ? {}
    : {
        voiceSessionGrantVerifier: executorRuntime.voiceSessionGrantVerifier,
      }),
  env,
});
