import type { JsonValue, ResolvedCredential } from "@eyeball/core";
import {
  createInProcessExecutorHarness,
  executionOutput as sharedExecutionOutput,
} from "../helpers/executor-harness.js";

type ProviderMock = NonNullable<
  Parameters<typeof createInProcessExecutorHarness>[0]["provider"]
>;

export interface ExecuteResult {
  status: number;
  body: Readonly<Record<string, unknown>>;
}

export interface SocialMockHarness {
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<ExecuteResult>;
  providerRequestCount(): number;
}

export function createSocialMockHarness(
  provider: ProviderMock,
  toolkitSlug: string,
  credential: ResolvedCredential,
): SocialMockHarness {
  const harness = createInProcessExecutorHarness({
    toolkitSlug,
    provider,
    credential,
    baseUrlEnv: "EYEBALL_SCRAPECREATORS_BASE_URL",
    label: `social_${toolkitSlug}`,
    apiKey: "ey_test_social_mocks",
    projectId: "proj_social_mocks",
    userId: "user_social_mocks",
    requestId: "req_social_mocks",
  });
  return {
    async execute(tool, input) {
      const result = await harness.execute(tool, input);
      return { status: result.initialStatus, body: result.terminal };
    },
    providerRequestCount: harness.providerRequestCount,
  };
}

export function executionOutput(
  result: ExecuteResult,
): Readonly<Record<string, unknown>> {
  return sharedExecutionOutput({
    initialStatus: result.status,
    initial: result.body,
    terminal: result.body,
  });
}
