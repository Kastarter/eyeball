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

const API_KEY = "ey_test_social_mocks";
const MOCK_ORIGIN = "http://mocks.local";
const PROJECT_ID = "proj_social_mocks";
const USER_ID = "user_social_mocks";

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
  let executionIndex = 0;
  let idempotencyIndex = 0;
  let providerRequests = 0;
  const mockApp = createMockApp({ providers: [provider] });
  const credentialProvider = new MockCredentialProvider([
    {
      match: { projectId: PROJECT_ID, userId: USER_ID, toolkitSlug },
      credential,
    },
  ]);
  const envName = "EYEBALL_SCRAPECREATORS_BASE_URL";
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== MOCK_ORIGIN) {
      throw new Error(`Unexpected provider origin: ${request.url}`);
    }
    providerRequests += 1;
    return mockApp.request(request);
  }) as typeof fetch;
  const engine = new ExecutionEngine({
    credentialProvider,
    fetchImpl,
    clock: provider.clock,
    env: { [envName]: `${MOCK_ORIGIN}/${provider.slug}` },
    executionIdFactory: () => {
      executionIndex += 1;
      return createExecutionId(
        `social_${toolkitSlug.replaceAll("-", "_")}_${executionIndex}`,
      );
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: { [API_KEY]: PROJECT_ID },
    requestIdFactory: () => "req_social_mocks",
  });

  return {
    async execute(tool, input) {
      idempotencyIndex += 1;
      const response = await app.request("/v1/execute", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `social-mock-${toolkitSlug}-${idempotencyIndex}`,
        },
        body: JSON.stringify({ tool, userId: USER_ID, input, mode: "sync" }),
      });
      const body = (await response.json()) as Readonly<Record<string, unknown>>;
      return { status: response.status, body };
    },
    providerRequestCount: () => providerRequests,
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
