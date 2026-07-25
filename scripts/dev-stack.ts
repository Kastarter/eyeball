#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { AdapterRegistry } from "../apps/executor/src/adapters/index.js";
import { InMemoryDevVault } from "../apps/executor/src/dev-vault.js";
import { DevVoiceSessionRuntime } from "../apps/executor/src/dev-voice-sessions.js";
import {
  ExecutionEngine,
  type ExecutionEngineOptions,
} from "../apps/executor/src/engine.js";
import { createExecutorApp } from "../apps/executor/src/routes.js";
import { createMcpGatewayApp } from "../apps/mcp-gateway/src/index.js";
import { defaultCatalog } from "../packages/catalog/src/index.js";
import {
  EyeballError,
  type ProviderManifest,
  type ResolvedCredential,
} from "../packages/core/src/index.js";
import {
  defaultToolkitAdapters,
  InMemoryAgentStore,
  TwilioAdapter,
  VoiceAgentsAdapter,
} from "../packages/toolkits/src/index.js";

const HOST = "127.0.0.1";
const DEFAULT_MOCKHOUSE_PORT = 4_010;
const DEFAULT_EXECUTOR_PORT = 3_000;
const DEFAULT_MCP_GATEWAY_PORT = 3_001;
const DEFAULT_API_KEY = "eyeball_dev_project";
const DEFAULT_PROJECT_ID = "proj_dev";
const DEFAULT_USER_ID = "demo_user";
// Deployment-scoped service identity for the mock Pipecat runtime. This is
// intentionally separate from the auth-free voice-agent management manifest.
const MOCKHOUSE_PIPECAT_RUNTIME_TOKEN = "fixture:valid";
const FULL_MOCKHOUSE_ENTRY = fileURLToPath(
  new URL("../mocks/apps/mockhouse/src/index.ts", import.meta.url),
);

type HonoServer = ReturnType<typeof serve>;
type FetchHandler = (request: Request) => Response | Promise<Response>;

interface MockhouseProvider {
  readonly slug: string;
  reset(): void;
}

interface MockhouseRuntime {
  readonly app: MockhouseApp;
  readonly providers: readonly MockhouseProvider[];
}

interface PipecatMockProvider extends MockhouseProvider {
  readonly clock: { now(): Date };
  advanceClock(milliseconds: number): void;
}

export interface DevStackOptions {
  mockhousePort?: number;
  executorPort?: number;
  mcpGatewayPort?: number;
  /** Use the public starter providers even when a full checkout is available. */
  mockhouse?: "auto" | "starter";
  apiKey?: string;
  projectId?: string;
  userId?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface DevStackRuntime {
  mockhouseUrl: string;
  executorUrl: string;
  mcpGatewayUrl: string;
  apiKey: string;
  projectId: string;
  userId: string;
  providerCount: number;
  close(): Promise<void>;
}

export interface InProcessDevStackRuntime {
  mockhouseUrl: string;
  executorUrl: string;
  mcpGatewayUrl: string;
  apiKey: string;
  projectId: string;
  userId: string;
  providerCount: number;
  mockhouseApp: MockhouseRuntime["app"];
  mockhouseProviders: MockhouseRuntime["providers"];
  executorEngine: ExecutionEngine;
  executorApp: ReturnType<typeof createExecutorApp>;
  mcpGatewayApp: ReturnType<typeof createMcpGatewayApp>;
}

export interface InProcessDevStackOptions extends DevStackOptions {
  /** Deterministic, in-process-only engine seams used by tests and benchmarks. */
  engineOptions?: Pick<
    ExecutionEngineOptions,
    "clock" | "executionIdFactory" | "fileIdFactory" | "telemetryRuntime"
  >;
}

interface ListeningServer {
  server: HonoServer;
  url: string;
}

interface StackIdentity {
  apiKey: string;
  projectId: string;
  userId: string;
}

interface RequestApp {
  request(
    request: Request | string,
    init?: RequestInit,
  ): Response | Promise<Response>;
}

interface MockhouseApp extends RequestApp {
  fetch: FetchHandler;
}

function isMockhouseRuntime(value: unknown): value is MockhouseRuntime {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { app?: unknown; providers?: unknown };
  if (typeof candidate.app !== "object" || candidate.app === null) {
    return false;
  }
  const app = candidate.app as { fetch?: unknown };
  return (
    typeof app.fetch === "function" &&
    Array.isArray(candidate.providers) &&
    candidate.providers.every(
      (provider) =>
        typeof provider === "object" &&
        provider !== null &&
        "slug" in provider &&
        typeof provider.slug === "string" &&
        "reset" in provider &&
        typeof provider.reset === "function",
    )
  );
}

function mockhouseRuntime(value: unknown, source: string): MockhouseRuntime {
  if (!isMockhouseRuntime(value)) {
    throw new Error(`${source} returned an invalid Mockhouse runtime.`);
  }
  return value;
}

function pipecatProvider(
  providers: readonly MockhouseProvider[],
): PipecatMockProvider | undefined {
  const provider = providers.find(({ slug }) => slug === "pipecat");
  if (
    provider === undefined ||
    typeof provider !== "object" ||
    !("clock" in provider) ||
    !("advanceClock" in provider)
  ) {
    return undefined;
  }
  const candidate = provider as {
    clock?: { now?: unknown };
    advanceClock?: unknown;
  };
  return typeof candidate.clock?.now === "function" &&
    typeof candidate.advanceClock === "function"
    ? (provider as PipecatMockProvider)
    : undefined;
}

async function createDevMockhouse(
  mode: DevStackOptions["mockhouse"] = "auto",
): Promise<MockhouseRuntime> {
  if (mode !== "starter" && existsSync(FULL_MOCKHOUSE_ENTRY)) {
    // The optional checkout is resolved only after its entry has been probed.
    // Keeping this specifier computed avoids a public build-time dependency on it.
    const fullMockhouse = (await import(
      pathToFileURL(FULL_MOCKHOUSE_ENTRY).href
    )) as {
      createMockhouse?: () => unknown;
    };
    if (typeof fullMockhouse.createMockhouse !== "function") {
      throw new Error(
        "Full Mockhouse checkout does not export createMockhouse.",
      );
    }
    return mockhouseRuntime(
      fullMockhouse.createMockhouse(),
      "Full Mockhouse checkout",
    );
  }

  const { createStarterMockhouse } = await import("@eyeball/mocks-starter");
  process.stdout.write(
    "starter mocks (4 providers): full Mockhouse checkout not present\n",
  );
  return mockhouseRuntime(createStarterMockhouse(), "Starter Mockhouse");
}

function configuredPort(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`${name} must be an integer from 0 through 65535.`);
  }
  return port;
}

function nonEmpty(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const selected = value ?? fallback;
  if (selected.trim().length === 0) {
    throw new Error(`${name} must not be empty.`);
  }
  return selected;
}

function stackIdentity(
  options: DevStackOptions,
  env: Readonly<Record<string, string | undefined>>,
): StackIdentity {
  return {
    apiKey: nonEmpty(
      options.apiKey ?? env.EYEBALL_DEV_API_KEY,
      DEFAULT_API_KEY,
      "EYEBALL_DEV_API_KEY",
    ),
    projectId: nonEmpty(
      options.projectId ?? env.EYEBALL_DEV_PROJECT_ID,
      DEFAULT_PROJECT_ID,
      "EYEBALL_DEV_PROJECT_ID",
    ),
    userId: nonEmpty(
      options.userId ?? env.EYEBALL_DEV_USER_ID,
      DEFAULT_USER_ID,
      "EYEBALL_DEV_USER_ID",
    ),
  };
}

function credentialForManifest(manifest: ProviderManifest): ResolvedCredential {
  switch (manifest.auth.class) {
    case "oauth2":
      return {
        type: "oauth2",
        accessToken: "fixture:valid",
        scopes: [
          ...(manifest.auth.requiredScopes ?? []),
          ...(manifest.auth.optionalScopes ?? []),
        ],
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    case "api_key":
      return {
        type: "api_key",
        values: Object.fromEntries(
          (manifest.auth.fields ?? ["apiKey"]).map((field) => {
            if (field === "phoneNumberId") {
              return [field, "fixture:15550001111"];
            }
            if (field === "apiSecret") {
              return [field, "fixture:secret"];
            }
            return [field, "fixture:valid"];
          }),
        ),
      };
    case "basic":
      if (manifest.toolkit.slug === "twilio") {
        return {
          type: "basic",
          username: "ACfixture",
          password: "fixture:valid",
        };
      }
      if (manifest.toolkit.slug === "odoo") {
        return {
          type: "basic",
          username: "fixture-user",
          password: "fixture:valid",
          parameters: { database: "fixture-db" },
        };
      }
      return {
        type: "basic",
        username: "fixture-user",
        password: "fixture:valid",
      };
    case "none":
      return { type: "none" };
  }
}

function mockProviderSlug(manifest: ProviderManifest): string {
  if (
    manifest.endpoint.baseUrlOverrideEnv === "EYEBALL_SCRAPECREATORS_BASE_URL"
  ) {
    return "scrapecreators";
  }
  if (manifest.toolkit.slug === "voice-agents") {
    return "pipecat";
  }
  return manifest.toolkit.slug;
}

function baseUrlOverrides(
  mockhouseUrl: string,
  manifests: readonly ProviderManifest[],
): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const manifest of manifests) {
    const envName = manifest.endpoint.baseUrlOverrideEnv;
    if (envName === undefined) {
      throw new Error(
        `Catalog manifest ${manifest.toolkit.slug} has no base-URL override environment variable.`,
      );
    }
    const providerSlug = mockProviderSlug(manifest);
    const value = `${mockhouseUrl}/${providerSlug}`;
    const existing = overrides[envName];
    if (existing !== undefined && existing !== value) {
      throw new Error(`Conflicting mock override values for ${envName}.`);
    }
    overrides[envName] = value;
  }
  return Object.freeze(overrides);
}

function inProcessFetch(origin: string, app: RequestApp): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== origin) {
      throw new Error(`Unexpected in-process request origin: ${request.url}`);
    }
    return app.request(request);
  }) as typeof fetch;
}

function serviceAuthenticatedFetch(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
): typeof fetch {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/u, "");
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin !== base.origin ||
      (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
    ) {
      throw new Error(
        `Unexpected Pipecat session-runtime request URL: ${request.url}`,
      );
    }
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchImpl(new Request(request, { headers }));
  }) as typeof fetch;
}

async function createMockBackedExecutor(
  mockhouse: MockhouseRuntime,
  mockhouseUrl: string,
  identity: StackIdentity,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
  engineOptions: InProcessDevStackOptions["engineOptions"] = {},
): Promise<{
  app: ReturnType<typeof createExecutorApp>;
  engine: ExecutionEngine;
}> {
  const providerSlugs = new Set(
    mockhouse.providers.map((provider) => provider.slug),
  );
  const manifests = defaultCatalog
    .listManifests()
    .filter((manifest) => providerSlugs.has(mockProviderSlug(manifest)));
  const executorEnv = {
    ...env,
    EYEBALL_LOG_FORMAT: env.EYEBALL_LOG_FORMAT ?? "pretty",
    ...baseUrlOverrides(mockhouseUrl, manifests),
  };
  const devVault = new InMemoryDevVault({
    credentials: Object.fromEntries(
      manifests.map((manifest) => [
        manifest.toolkit.slug,
        credentialForManifest(manifest),
      ]),
    ),
  });
  await Promise.all(
    manifests.map((manifest) =>
      devVault.createConnection({
        projectId: identity.projectId,
        userId: identity.userId,
        toolkit: manifest.toolkit.slug,
      }),
    ),
  );
  const agentStore = new InMemoryAgentStore();
  let boundEngine: ExecutionEngine | undefined;
  const pipecat = pipecatProvider(mockhouse.providers);
  const providerFetch = fetchImpl ?? globalThis.fetch;
  const pipecatBaseUrl = `${mockhouseUrl}/pipecat`;
  const sessionRuntimeFetch =
    pipecat === undefined
      ? undefined
      : serviceAuthenticatedFetch(
          providerFetch,
          pipecatBaseUrl,
          MOCKHOUSE_PIPECAT_RUNTIME_TOKEN,
        );
  const voiceAgents =
    sessionRuntimeFetch === undefined
      ? undefined
      : new VoiceAgentsAdapter({
          store: agentStore,
          sessionRuntimeFetch,
          resolveTool: (name) => defaultCatalog.getTool(name),
          executeProviderTool: async (request) => {
            if (boundEngine === undefined) {
              throw new Error(
                "Voice provider executor was used before dev-stack runtime binding.",
              );
            }
            const outcome = await boundEngine.execute({
              projectId: request.projectId,
              idempotencyKey: `voice-provider-${randomUUID()}`,
              request: {
                tool: request.tool,
                userId: request.userId,
                connectionId: request.connectionId,
                input: request.input,
                mode: "sync",
              },
            });
            const response = outcome.response;
            if (response.status === "succeeded") return response.output;
            if (
              response.status === "failed" ||
              response.status === "cancelled"
            ) {
              throw new EyeballError({
                code: response.error.code,
                message: response.error.message,
                retryable: response.error.retryable,
                ...(response.error.retryAfter === undefined
                  ? {}
                  : { retryAfter: response.error.retryAfter }),
                ...(response.error.provider === undefined
                  ? {}
                  : { providerDetail: response.error.provider }),
              });
            }
            throw new Error(
              `Nested synchronous provider execution returned ${response.status}.`,
            );
          },
        });
  if (pipecat === undefined) {
    process.stdout.write(
      "voice session runtime disabled: Pipecat mock provider is not present\n",
    );
  }
  const twilio = new TwilioAdapter({ bindingLookup: agentStore });
  const engine = new ExecutionEngine({
    catalog: defaultCatalog,
    adapters: new AdapterRegistry(
      defaultToolkitAdapters.map((adapter) => {
        if (
          adapter.toolkitSlug === "voice-agents" &&
          voiceAgents !== undefined
        ) {
          return voiceAgents;
        }
        if (adapter.toolkitSlug === "twilio") return twilio;
        return adapter;
      }),
    ),
    credentialProvider: devVault,
    env: executorEnv,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...engineOptions,
  });
  boundEngine = engine;
  const devVoiceSessions =
    pipecat === undefined || sessionRuntimeFetch === undefined
      ? undefined
      : new DevVoiceSessionRuntime({
          engine,
          agentStore,
          pipecatBaseUrl,
          fetch: sessionRuntimeFetch,
          clock: {
            now: () => pipecat.clock.now(),
            advance: (milliseconds) => {
              pipecat.advanceClock(milliseconds);
            },
          },
        });
  return {
    engine,
    app: createExecutorApp({
      engine,
      devVault,
      ...(devVoiceSessions === undefined ? {} : { devVoiceSessions }),
      apiKeys: { [identity.apiKey]: identity.projectId },
      env: executorEnv,
    }),
  };
}

function listen(fetch: FetchHandler, port: number): Promise<ListeningServer> {
  return new Promise((resolveListening, rejectListening) => {
    const server = serve({ fetch, hostname: HOST, port }, (address) => {
      server.off("error", rejectListening);
      resolveListening({
        server,
        url: `http://${HOST}:${address.port}`,
      });
    });
    server.once("error", rejectListening);
  });
}

function closeServer(server: HonoServer): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}

export async function startDevStack(
  options: DevStackOptions = {},
): Promise<DevStackRuntime> {
  const env = options.env ?? process.env;
  const identity = stackIdentity(options, env);
  const mockhousePort =
    options.mockhousePort ??
    configuredPort(
      env.EYEBALL_MOCKHOUSE_PORT,
      DEFAULT_MOCKHOUSE_PORT,
      "EYEBALL_MOCKHOUSE_PORT",
    );
  const executorPort =
    options.executorPort ??
    configuredPort(
      env.EYEBALL_EXECUTOR_PORT,
      DEFAULT_EXECUTOR_PORT,
      "EYEBALL_EXECUTOR_PORT",
    );
  const mcpGatewayPort =
    options.mcpGatewayPort ??
    configuredPort(
      env.EYEBALL_MCP_GATEWAY_PORT,
      DEFAULT_MCP_GATEWAY_PORT,
      "EYEBALL_MCP_GATEWAY_PORT",
    );
  const servers: HonoServer[] = [];

  try {
    const mockhouse = await createDevMockhouse(options.mockhouse);
    const mockhouseServer = await listen(mockhouse.app.fetch, mockhousePort);
    servers.push(mockhouseServer.server);
    const { app: executorApp } = await createMockBackedExecutor(
      mockhouse,
      mockhouseServer.url,
      identity,
      env,
    );
    const executorServer = await listen(executorApp.fetch, executorPort);
    servers.push(executorServer.server);

    const gatewayApp = createMcpGatewayApp({
      executorBaseUrl: executorServer.url,
      apiKey: identity.apiKey,
      userId: identity.userId,
    });
    const gatewayServer = await listen(gatewayApp.fetch, mcpGatewayPort);
    servers.push(gatewayServer.server);

    let closed = false;
    return {
      mockhouseUrl: mockhouseServer.url,
      executorUrl: executorServer.url,
      mcpGatewayUrl: `${gatewayServer.url}/mcp`,
      apiKey: identity.apiKey,
      projectId: identity.projectId,
      userId: identity.userId,
      providerCount: mockhouse.providers.length,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        await Promise.all([...servers].reverse().map(closeServer));
      },
    };
  } catch (error) {
    await Promise.all([...servers].reverse().map(closeServer));
    throw error;
  }
}

/** Creates the same three-service composition without opening sockets. */
export async function createInProcessDevStack(
  options: InProcessDevStackOptions = {},
): Promise<InProcessDevStackRuntime> {
  const env = options.env ?? process.env;
  const identity = stackIdentity(options, env);
  const mockhouseUrl = "http://mockhouse.dev-stack.test";
  const executorUrl = "http://executor.dev-stack.test";
  const mcpGatewayOrigin = "http://mcp-gateway.dev-stack.test";
  const mockhouse = await createDevMockhouse(options.mockhouse);
  const { app: executorApp, engine: executorEngine } =
    await createMockBackedExecutor(
      mockhouse,
      mockhouseUrl,
      identity,
      env,
      inProcessFetch(mockhouseUrl, mockhouse.app),
      options.engineOptions,
    );
  const mcpGatewayApp = createMcpGatewayApp({
    executorBaseUrl: executorUrl,
    fetchImpl: inProcessFetch(executorUrl, executorApp),
    apiKey: identity.apiKey,
    userId: identity.userId,
  });
  return {
    mockhouseUrl,
    executorUrl,
    mcpGatewayUrl: `${mcpGatewayOrigin}/mcp`,
    ...identity,
    providerCount: mockhouse.providers.length,
    mockhouseApp: mockhouse.app,
    mockhouseProviders: mockhouse.providers,
    executorEngine,
    executorApp,
    mcpGatewayApp,
  };
}

async function runDevStack(): Promise<void> {
  const stack = await startDevStack();
  // Keys are redacted in logs by default; a real key may be supplied via env.
  const showFullKey = process.argv.includes("--show-key");
  const apiKeyLine = showFullKey
    ? `project API key: ${stack.apiKey}`
    : `project API key: ${stack.apiKey.slice(0, 4)}… (run with --show-key to print)`;
  process.stdout.write(
    `${[
      "eyeball dev stack ready",
      `mockhouse (${stack.providerCount} providers): ${stack.mockhouseUrl}`,
      `executor: ${stack.executorUrl}`,
      `mcp gateway: ${stack.mcpGatewayUrl}`,
      apiKeyLine,
      `default user: ${stack.userId}`,
    ].join("\n")}\n`,
  );

  let closing = false;
  const close = (signal: NodeJS.Signals) => {
    if (closing) {
      return;
    }
    closing = true;
    void stack
      .close()
      .then(() => {
        process.stdout.write(`eyeball dev stack stopped (${signal})\n`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`eyeball dev stack shutdown failed: ${message}\n`);
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  runDevStack().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`eyeball dev stack failed: ${message}\n`);
    process.exitCode = 1;
  });
}
