import type {
  JsonValue,
  ResolvedCredential,
  ToolkitAdapter,
} from "@eyeball/core";
import type { ProviderMock } from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  createInProcessExecutorHarness,
  executionOutput,
  type HarnessExecuteResult,
} from "../helpers/executor-harness.js";

export type VoiceExecuteResult = HarnessExecuteResult;

export interface VoiceMockHarness {
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
    mode?: "sync" | "async",
  ): Promise<VoiceExecuteResult>;
}

export interface VoiceMockHarnessOptions {
  toolkitSlug?: string;
  adapter?: ToolkitAdapter;
}

export function createVoiceMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
  options: VoiceMockHarnessOptions = {},
): VoiceMockHarness {
  const toolkitSlug = options.toolkitSlug ?? provider.slug;
  const harness = createInProcessExecutorHarness({
    toolkitSlug,
    provider,
    credential,
    ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    label: `voice_${toolkitSlug}`,
    apiKey: "ey_test_voice_mocks",
    projectId: "proj_voice_mocks",
    userId: "user_voice_mocks",
    requestId: "req_voice_mocks",
  });
  return { execute: harness.execute };
}

export { executionOutput as output };
