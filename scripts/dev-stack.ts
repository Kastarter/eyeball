#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
  createExecutorApp,
  ExecutionEngine,
  InMemoryDevVault,
} from "../apps/executor/src/index.js";
import { createMcpGatewayApp } from "../apps/mcp-gateway/src/index.js";
import { createMockhouse } from "../mocks/apps/mockhouse/src/index.js";
import { defaultCatalog } from "../packages/catalog/src/index.js";
import type {
  ProviderManifest,
  ResolvedCredential,
} from "../packages/core/src/index.js";

const HOST = "127.0.0.1";
const DEFAULT_MOCKHOUSE_PORT = 4_010;
const DEFAULT_EXECUTOR_PORT = 3_000;
const DEFAULT_MCP_GATEWAY_PORT = 3_001;
const DEFAULT_API_KEY = "eyeball_dev_project";
const DEFAULT_PROJECT_ID = "proj_dev";
const DEFAULT_USER_ID = "demo_user";

type HonoServer = ReturnType<typeof serve>;
type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface DevStackOptions {
  mockhousePort?: number;
  executorPort?: number;
  mcpGatewayPort?: number;
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
  mockhouseApp: ReturnType<typeof createMockhouse>["app"];
  executorApp: ReturnType<typeof createExecutorApp>;
  mcpGatewayApp: ReturnType<typeof createMcpGatewayApp>;
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
  request(request: Request): Response | Promise<Response>;
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
  providerSlugs: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const overrides: Record<string, string> = {};
  for (const manifest of defaultCatalog.listManifests()) {
    const envName = manifest.endpoint.baseUrlOverrideEnv;
    if (envName === undefined) {
      throw new Error(
        `Catalog manifest ${manifest.toolkit.slug} has no base-URL override environment variable.`,
      );
    }
    const providerSlug = mockProviderSlug(manifest);
    if (!providerSlugs.has(providerSlug)) {
      throw new Error(
        `Mockhouse does not mount ${providerSlug}, required by ${manifest.toolkit.slug}.`,
      );
    }
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

async function createMockBackedExecutor(
  mockhouse: ReturnType<typeof createMockhouse>,
  mockhouseUrl: string,
  identity: StackIdentity,
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: typeof fetch,
): Promise<ReturnType<typeof createExecutorApp>> {
  const providerSlugs = new Set(
    mockhouse.providers.map((provider) => provider.slug),
  );
  const executorEnv = {
    ...env,
    ...baseUrlOverrides(mockhouseUrl, providerSlugs),
  };
  const manifests = defaultCatalog.listManifests();
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
  const engine = new ExecutionEngine({
    catalog: defaultCatalog,
    credentialProvider: devVault,
    env: executorEnv,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return createExecutorApp({
    engine,
    devVault,
    apiKeys: { [identity.apiKey]: identity.projectId },
    env: executorEnv,
  });
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
    const mockhouse = createMockhouse();
    const mockhouseServer = await listen(mockhouse.app.fetch, mockhousePort);
    servers.push(mockhouseServer.server);
    const executorApp = await createMockBackedExecutor(
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
  options: DevStackOptions = {},
): Promise<InProcessDevStackRuntime> {
  const env = options.env ?? process.env;
  const identity = stackIdentity(options, env);
  const mockhouseUrl = "http://mockhouse.dev-stack.test";
  const executorUrl = "http://executor.dev-stack.test";
  const mcpGatewayOrigin = "http://mcp-gateway.dev-stack.test";
  const mockhouse = createMockhouse();
  const executorApp = await createMockBackedExecutor(
    mockhouse,
    mockhouseUrl,
    identity,
    env,
    inProcessFetch(mockhouseUrl, mockhouse.app),
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
