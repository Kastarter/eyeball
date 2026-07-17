import type {
  JsonValue,
  ResolvedCredential,
  StagedFileReference,
} from "@eyeball/core";
import type { ProviderMock } from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  createInProcessExecutorHarness,
  executionOutput as sharedExecutionOutput,
} from "../helpers/executor-harness.js";

export interface ExecuteResult {
  status: number;
  body: Readonly<Record<string, unknown>>;
}

export interface ProductivityMockHarness {
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<ExecuteResult>;
  stageFile(options: {
    name: string;
    mimeType?: string;
    content: string | Uint8Array;
  }): Promise<StagedFileReference>;
  providerRequestCount(): number;
  providerRequests(): readonly {
    url: string;
    method: string;
    body: string;
    bodyBase64: string;
    contentType: string | null;
  }[];
}

export function createProductivityMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
): ProductivityMockHarness {
  const harness = createInProcessExecutorHarness({
    toolkitSlug: provider.slug,
    provider,
    credential,
    label: `productivity_${provider.slug}`,
    apiKey: "ey_test_productivity_mocks",
    projectId: "proj_productivity_mocks",
    userId: "user_productivity_mocks",
    requestId: "req_productivity_mocks",
  });
  return {
    async execute(tool, input) {
      const result = await harness.execute(tool, input);
      return { status: result.initialStatus, body: result.terminal };
    },
    stageFile: (options) => harness.stageFile(options),
    providerRequestCount: harness.providerRequestCount,
    providerRequests: harness.providerRequests,
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
