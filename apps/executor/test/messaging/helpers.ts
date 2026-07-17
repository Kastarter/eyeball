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

export interface MessagingMockHarness {
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<ExecuteResult>;
}

export function createMessagingMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
): MessagingMockHarness {
  const harness = createInProcessExecutorHarness({
    toolkitSlug: provider.slug,
    provider,
    credential,
    label: `messaging_${provider.slug}`,
    apiKey: "ey_test_messaging_mocks",
    projectId: "proj_messaging_mocks",
    userId: "user_messaging_mocks",
    requestId: "req_messaging_mocks",
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

export function storeRecords<T extends object>(
  provider: ProviderMock,
  storeName: string,
): Array<T & { id: string }> {
  const store = provider.stores[storeName];
  if (store === undefined) {
    throw new Error(`Missing provider store: ${storeName}`);
  }
  const snapshot = store.snapshot() as { records?: Array<T & { id: string }> };
  if (!Array.isArray(snapshot.records)) {
    throw new Error(`Invalid provider store snapshot: ${storeName}`);
  }
  return snapshot.records;
}
