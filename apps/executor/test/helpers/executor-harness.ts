import {
  type CredentialProvider,
  createExecutionId,
  type JsonValue,
  MockCredentialProvider,
  type ResolvedCredential,
  type ToolkitAdapter,
} from "@eyeball/core";
import { defaultToolkitAdapters } from "@eyeball/toolkits";
import {
  createMockApp,
  type ProviderMock,
} from "../../../../mocks/packages/mock-kit/dist/index.js";
import {
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
} from "../../src/index.js";

const API_KEY = "ey_test_in_process";
const MOCK_ORIGIN = "http://mocks.local";
const PROJECT_ID = "proj_in_process";
const USER_ID = "user_in_process";

export interface HarnessExecuteResult {
  initialStatus: number;
  initial: Readonly<Record<string, unknown>>;
  terminal: Readonly<Record<string, unknown>>;
}

export interface InProcessExecutorHarness {
  readonly projectId: string;
  readonly userId: string;
  execute(
    tool: string,
    input: Readonly<Record<string, JsonValue>>,
    mode?: "sync" | "async",
  ): Promise<HarnessExecuteResult>;
  providerRequestCount(): number;
  advanceClock(milliseconds: number): Promise<void>;
}

export interface InProcessExecutorHarnessOptions {
  toolkitSlug: string;
  provider?: ProviderMock;
  credential?: ResolvedCredential;
  credentialProvider?: CredentialProvider;
  adapter?: ToolkitAdapter;
  env?: Readonly<Record<string, string | undefined>>;
  baseUrl?: string;
  baseUrlEnv?: string;
  label?: string;
  apiKey?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
}

function envSlug(value: string): string {
  return value.toUpperCase().replaceAll("-", "_");
}

function adapterRegistry(adapter: ToolkitAdapter | undefined): AdapterRegistry {
  if (adapter === undefined) {
    return new AdapterRegistry(defaultToolkitAdapters);
  }
  return new AdapterRegistry([
    ...defaultToolkitAdapters.filter(
      (candidate) => candidate.toolkitSlug !== adapter.toolkitSlug,
    ),
    adapter,
  ]);
}

function objectBody(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Executor returned a non-object body: ${JSON.stringify(value)}`,
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

export function createInProcessExecutorHarness(
  options: InProcessExecutorHarnessOptions,
): InProcessExecutorHarness {
  let executionIndex = 0;
  let idempotencyIndex = 0;
  let providerRequests = 0;
  const label = (options.label ?? options.toolkitSlug).replaceAll("-", "_");
  const apiKey = options.apiKey ?? API_KEY;
  const projectId = options.projectId ?? PROJECT_ID;
  const userId = options.userId ?? USER_ID;
  const baseUrlEnv =
    options.baseUrlEnv ?? `EYEBALL_${envSlug(options.toolkitSlug)}_BASE_URL`;
  const baseUrl =
    options.baseUrl ??
    (options.provider === undefined
      ? options.env?.[baseUrlEnv]
      : `${MOCK_ORIGIN}/${options.provider.slug}`);
  const env = {
    ...options.env,
    ...(baseUrl === undefined ? {} : { [baseUrlEnv]: baseUrl }),
  };

  const mockApp =
    options.provider === undefined
      ? undefined
      : createMockApp({ providers: [options.provider] });
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    providerRequests += 1;
    if (mockApp === undefined) {
      return fetch(request);
    }
    if (new URL(request.url).origin !== MOCK_ORIGIN) {
      throw new Error(`Unexpected provider origin: ${request.url}`);
    }
    return mockApp.request(request);
  }) as typeof fetch;

  const credentialProvider =
    options.credentialProvider ??
    new MockCredentialProvider(
      options.credential === undefined
        ? []
        : [
            {
              match: {
                projectId,
                userId,
                toolkitSlug: options.toolkitSlug,
              },
              credential: options.credential,
            },
          ],
    );
  const engine = new ExecutionEngine({
    adapters: adapterRegistry(options.adapter),
    credentialProvider,
    fetchImpl,
    ...(options.provider === undefined
      ? {}
      : { clock: options.provider.clock }),
    env,
    executionIdFactory: () => {
      executionIndex += 1;
      return createExecutionId(`${label}_${executionIndex}`);
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: { [apiKey]: projectId },
    requestIdFactory: () => options.requestId ?? `req_${label}`,
  });

  return {
    projectId,
    userId,
    async execute(tool, input, mode = "sync") {
      idempotencyIndex += 1;
      const response = await app.request("/v1/execute", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `${label}-${idempotencyIndex}`,
        },
        body: JSON.stringify({ tool, userId, input, mode }),
      });
      const initial = objectBody(await response.json());
      if (response.status !== 202) {
        return {
          initialStatus: response.status,
          initial,
          terminal: initial,
        };
      }

      await engine.queue.onIdle();
      const terminalResponse = await app.request(
        `/v1/executions/${encodeURIComponent(String(initial.executionId))}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return {
        initialStatus: response.status,
        initial,
        terminal: objectBody(await terminalResponse.json()),
      };
    },
    providerRequestCount: () => providerRequests,
    async advanceClock(milliseconds) {
      if (options.provider === undefined) {
        return;
      }
      await options.provider.advanceClock(milliseconds);
    },
  };
}

export function executionOutput(
  result: HarnessExecuteResult,
): Readonly<Record<string, unknown>> {
  if (result.terminal.status !== "succeeded") {
    throw new Error(`Execution failed: ${JSON.stringify(result.terminal)}`);
  }
  return objectBody(result.terminal.output);
}
