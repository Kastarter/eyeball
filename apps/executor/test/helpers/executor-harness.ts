import {
  type CredentialProvider,
  createExecutionId,
  type JsonValue,
  MockCredentialProvider,
  type ResolvedCredential,
  type StagedFileReference,
  type ToolkitAdapter,
} from "@eyeball/core";
import { defaultToolkitAdapters } from "@eyeball/toolkits";
import {
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
} from "../../src/index.js";
import {
  hasMocksCheckout,
  loadMocksModule,
  type MockKitModule,
  type ProviderMock,
} from "../mocks-checkout.js";

const createMockApp = hasMocksCheckout()
  ? (await loadMocksModule<MockKitModule>("mock-kit")).createMockApp
  : undefined;

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

function googleDriveMultipartRequest(
  request: Request,
  body: Buffer,
): Request | undefined {
  const url = new URL(request.url);
  if (
    !url.pathname.endsWith("/upload/drive/v3/files") ||
    url.searchParams.get("uploadType") !== "multipart"
  ) {
    return undefined;
  }
  const contentType = request.headers.get("Content-Type") ?? "";
  const boundary = /boundary="?([^";]+)"?/iu.exec(contentType)?.[1];
  if (boundary === undefined) {
    throw new Error("Drive multipart fixture omitted its boundary.");
  }
  const separator = Buffer.from(`\r\n--${boundary}`, "utf8");
  const headerSeparator = Buffer.from("\r\n\r\n", "utf8");
  const metadataHeaderEnd = body.indexOf(headerSeparator);
  const secondBoundary = body.indexOf(
    separator,
    metadataHeaderEnd + headerSeparator.length,
  );
  const contentHeaderEnd = body.indexOf(
    headerSeparator,
    secondBoundary + separator.length,
  );
  const closingBoundary = body.indexOf(
    Buffer.from(`\r\n--${boundary}--`, "utf8"),
    contentHeaderEnd + headerSeparator.length,
  );
  if (
    metadataHeaderEnd < 0 ||
    secondBoundary < 0 ||
    contentHeaderEnd < 0 ||
    closingBoundary < 0
  ) {
    throw new Error("Drive multipart fixture body is malformed.");
  }
  const metadata = JSON.parse(
    body
      .subarray(metadataHeaderEnd + headerSeparator.length, secondBoundary)
      .toString("utf8"),
  ) as unknown;
  const content = body.subarray(
    contentHeaderEnd + headerSeparator.length,
    closingBoundary,
  );
  const legacyUrl = new URL(request.url);
  legacyUrl.pathname = legacyUrl.pathname.replace(
    "/upload/drive/v3/files",
    "/drive/v3/files",
  );
  legacyUrl.search = "";
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(legacyUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ metadata, content: content.toString("utf8") }),
  });
}

export function createInProcessExecutorHarness(
  options: InProcessExecutorHarnessOptions,
): InProcessExecutorHarness {
  let executionIndex = 0;
  let idempotencyIndex = 0;
  let providerRequests = 0;
  const providerRequestLog: {
    url: string;
    method: string;
    body: string;
    bodyBase64: string;
    contentType: string | null;
  }[] = [];
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

  const mockApp = (() => {
    if (options.provider === undefined) {
      return undefined;
    }
    if (createMockApp === undefined) {
      throw new Error("Mockhouse checkout is required for a provider harness.");
    }
    return createMockApp({ providers: [options.provider] });
  })();
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    const requestBody = Buffer.from(await request.clone().arrayBuffer());
    providerRequests += 1;
    providerRequestLog.push({
      url: request.url,
      method: request.method,
      body: requestBody.toString("utf8"),
      bodyBase64: requestBody.toString("base64"),
      contentType: request.headers.get("Content-Type"),
    });
    if (mockApp === undefined) {
      return fetch(request);
    }
    if (new URL(request.url).origin !== MOCK_ORIGIN) {
      throw new Error(`Unexpected provider origin: ${request.url}`);
    }
    // Mockhouse protects provider routes independently of the provider manifest.
    // Native `none`-auth runtimes therefore still need the test-only transport token.
    if (
      options.credential?.type === "none" &&
      !request.headers.has("Authorization")
    ) {
      request.headers.set("Authorization", "Bearer fixture:valid");
    }
    return mockApp.request(
      options.provider?.slug === "google-drive"
        ? (googleDriveMultipartRequest(request, requestBody) ?? request)
        : request,
    );
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
    async stageFile({ name, mimeType, content }) {
      const bytes =
        typeof content === "string"
          ? Buffer.from(content, "utf8")
          : Buffer.from(content);
      const response = await app.request("/v1/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          mimeType: mimeType ?? "application/octet-stream",
          content: bytes.toString("base64"),
        }),
      });
      const metadata = objectBody(await response.json());
      if (response.status !== 201) {
        throw new Error(`File staging failed: ${JSON.stringify(metadata)}`);
      }
      return {
        fileId: String(metadata.fileId) as StagedFileReference["fileId"],
        name: String(metadata.name),
        mimeType: String(metadata.mimeType),
      };
    },
    providerRequestCount: () => providerRequests,
    providerRequests: () => structuredClone(providerRequestLog),
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
