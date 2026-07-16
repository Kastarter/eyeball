import {
  createExecutionId,
  type JsonValue,
  MockCredentialProvider,
  type ResolvedCredential,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  createMockApp,
  type ProviderMock,
} from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
} from "../../src/index.js";

const API_KEY = "ey_test_voice_mocks";
const MOCK_ORIGIN = "http://mocks.local";
const PROJECT_ID = "proj_voice_mocks";
const USER_ID = "user_voice_mocks";

export interface VoiceExecuteResult {
  initialStatus: number;
  initial: Readonly<Record<string, unknown>>;
  terminal: Readonly<Record<string, unknown>>;
}

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

export function createVoiceMockHarness(
  provider: ProviderMock,
  credential: ResolvedCredential,
  options: VoiceMockHarnessOptions = {},
): VoiceMockHarness {
  let executionIndex = 0;
  let idempotencyIndex = 0;
  const toolkitSlug = options.toolkitSlug ?? provider.slug;
  const credentialProvider = new MockCredentialProvider([
    {
      match: { projectId: PROJECT_ID, userId: USER_ID, toolkitSlug },
      credential,
    },
  ]);
  const envName = `EYEBALL_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_BASE_URL`;
  const engine = new ExecutionEngine({
    ...(options.adapter === undefined
      ? {}
      : { adapters: new AdapterRegistry([options.adapter]) }),
    credentialProvider,
    fetchImpl: fetchFor(provider),
    clock: provider.clock,
    env: { [envName]: `${MOCK_ORIGIN}/${provider.slug}` },
    executionIdFactory: () => {
      executionIndex += 1;
      return createExecutionId(
        `voice_${toolkitSlug.replaceAll("-", "_")}_${executionIndex}`,
      );
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: { [API_KEY]: PROJECT_ID },
    requestIdFactory: () => "req_voice_mocks",
  });

  return {
    async execute(tool, input, mode = "sync") {
      idempotencyIndex += 1;
      const response = await app.request("/v1/execute", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `voice-mock-${toolkitSlug}-${idempotencyIndex}`,
        },
        body: JSON.stringify({ tool, userId: USER_ID, input, mode }),
      });
      const initial = (await response.json()) as Readonly<
        Record<string, unknown>
      >;
      if (response.status !== 202) {
        return {
          initialStatus: response.status,
          initial,
          terminal: initial,
        };
      }
      await engine.queue.onIdle();
      const executionId = String(initial.executionId);
      const terminalResponse = await app.request(
        `/v1/executions/${encodeURIComponent(executionId)}`,
        { headers: { Authorization: `Bearer ${API_KEY}` } },
      );
      return {
        initialStatus: response.status,
        initial,
        terminal: (await terminalResponse.json()) as Readonly<
          Record<string, unknown>
        >,
      };
    },
  };
}

export function output(
  result: VoiceExecuteResult,
): Readonly<Record<string, unknown>> {
  if (result.terminal.status !== "succeeded") {
    throw new Error(`Execution failed: ${JSON.stringify(result.terminal)}`);
  }
  const value = result.terminal.output;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Execution output is not an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}
