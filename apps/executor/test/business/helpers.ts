import type { JsonValue, ResolvedCredential } from "@eyeball/core";
import type { ProviderMock } from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  createInProcessExecutorHarness,
  executionOutput as sharedExecutionOutput,
} from "../helpers/executor-harness.js";

export interface ExecuteResult {
  status: number;
  body: Readonly<Record<string, unknown>>;
}

export interface BusinessMockHarness {
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<ExecuteResult>;
}

export function createBusinessMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
): BusinessMockHarness {
  const harness = createInProcessExecutorHarness({
    toolkitSlug: provider.slug,
    provider,
    credential,
    label: `business_${provider.slug}`,
    apiKey: "ey_test_business_mocks",
    projectId: "proj_business_mocks",
    userId: "user_business_mocks",
    requestId: "req_business_mocks",
  });
  return {
    async execute(tool, input) {
      const result = await harness.execute(tool, input);
      return { status: result.initialStatus, body: result.terminal };
    },
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
