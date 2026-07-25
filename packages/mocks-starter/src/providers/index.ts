import type { ProviderMock } from "../kit/index.js";
import { createGitHubMock } from "./github.js";
import { createGmailMock } from "./gmail.js";
import { createSlackMock } from "./slack.js";

export {
  type CreateEchoProviderOptions,
  createEchoProvider,
  type EchoMessage,
} from "./echo.js";

/**
 * Provider ports append their `ProviderMock` instances to this registry.
 * The starter app always mounts its echo provider separately as a reference.
 */
export const providers: readonly ProviderMock[] = [
  createGitHubMock(),
  createGmailMock(),
  createSlackMock(),
];
