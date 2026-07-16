import {
  createExecutionId,
  type JsonValue,
  MockCredentialProvider,
  type ResolvedCredential,
} from "@eyeball/core";
import {
  createMockApp,
  type ProviderMock,
} from "../../../../mocks/packages/mock-kit/dist/index.js";
import { createExecutorApp, ExecutionEngine } from "../../src/index.js";

const API_KEY = "ey_test_messaging_mocks";
const MOCK_ORIGIN = "http://mocks.local";
const PROJECT_ID = "proj_messaging_mocks";
const USER_ID = "user_messaging_mocks";

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

function fetchFor(provider: ProviderMock): typeof fetch {
  const mockApp = createMockApp({ providers: [provider] });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== MOCK_ORIGIN) {
      throw new Error(`Unexpected provider origin: ${request.url}`);
    }
    return mockApp.request(request);
  }) as typeof fetch;
}

export function createMessagingMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
): MessagingMockHarness {
  let executionIndex = 0;
  let idempotencyIndex = 0;
  const toolkitSlug = provider.slug;
  const credentialProvider = new MockCredentialProvider([
    {
      match: { projectId: PROJECT_ID, userId: USER_ID, toolkitSlug },
      credential,
    },
  ]);
  const envName = `EYEBALL_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_BASE_URL`;
  const engine = new ExecutionEngine({
    credentialProvider,
    fetchImpl: fetchFor(provider),
    clock: provider.clock,
    env: { [envName]: `${MOCK_ORIGIN}/${toolkitSlug}` },
    executionIdFactory: () => {
      executionIndex += 1;
      return createExecutionId(
        `messaging_${toolkitSlug.replaceAll("-", "_")}_${executionIndex}`,
      );
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: { [API_KEY]: PROJECT_ID },
    requestIdFactory: () => "req_messaging_mocks",
  });

  return {
    async execute(tool, input) {
      idempotencyIndex += 1;
      const response = await app.request("/v1/execute", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `messaging-mock-${toolkitSlug}-${idempotencyIndex}`,
        },
        body: JSON.stringify({ tool, userId: USER_ID, input, mode: "sync" }),
      });
      const body = (await response.json()) as Readonly<Record<string, unknown>>;
      return { status: response.status, body };
    },
  };
}

export function executionOutput(
  result: ExecuteResult,
): Readonly<Record<string, unknown>> {
  if (result.status !== 200 || result.body.status !== "succeeded") {
    throw new Error(
      `Execution did not succeed: ${JSON.stringify(result.body)}`,
    );
  }
  const output = result.body.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    throw new Error("Execution output is not an object.");
  }
  return output as Readonly<Record<string, unknown>>;
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
