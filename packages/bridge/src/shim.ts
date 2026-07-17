import type {
  AdapterContext,
  FetchImplementation,
  JsonValue,
  ResolvedCredential,
  ToolkitAdapter,
  ToolkitSlug,
} from "@eyeball/core";
import { resolvedCredentialToPieceAuth } from "./auth.js";
import { createRoutedFetch, runInsidePieceBoundary } from "./transport.js";
import type {
  ActivepiecesAction,
  ActivepiecesPiece,
  PieceExecutionBoundary,
  PieceFetchRoute,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedContextApi(name: string): never {
  throw new Error(
    `Activepieces ${name} is not supported by the experimental bridge.`,
  );
}

function scopeKey(key: string, scope?: unknown): string {
  return `${scope === undefined ? "FLOW" : String(scope)}:${key}`;
}

/** Process-local store sufficient for proving the Activepieces action contract. */
export class MemoryPieceStore {
  readonly #values = new Map<string, unknown>();

  async put<T>(key: string, value: T, scope?: unknown): Promise<T> {
    this.#values.set(scopeKey(key, scope), value);
    return value;
  }

  async get<T>(key: string, scope?: unknown): Promise<T | null> {
    return (this.#values.get(scopeKey(key, scope)) as T | undefined) ?? null;
  }

  async delete(key: string, scope?: unknown): Promise<void> {
    this.#values.delete(scopeKey(key, scope));
  }
}

function serializeRequestBody(
  value: unknown,
  headers: Headers,
): RequestInit["body"] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(value);
}

function createFetchHttpClient(fetchImpl: FetchImplementation) {
  return {
    async sendRequest(request: Readonly<Record<string, unknown>>) {
      const url = new URL(String(request.url));
      if (isRecord(request.queryParams)) {
        for (const [name, value] of Object.entries(request.queryParams)) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(name, String(value));
          }
        }
      }
      const headers = new Headers(
        isRecord(request.headers)
          ? Object.fromEntries(
              Object.entries(request.headers).map(([name, value]) => [
                name,
                String(value),
              ]),
            )
          : undefined,
      );
      const requestBody = serializeRequestBody(request.body, headers);
      const response = await fetchImpl(url, {
        method: String(request.method ?? "GET"),
        headers,
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
      const responseHeaders = Object.fromEntries(response.headers.entries());
      const contentType = response.headers.get("content-type") ?? "";
      const body = contentType.includes("json")
        ? await response.json()
        : await response.text();
      return { status: response.status, headers: responseHeaders, body };
    },
  };
}

export interface ExecutePieceActionOptions {
  readonly piece: ActivepiecesPiece;
  readonly action: ActivepiecesAction;
  readonly credential: ResolvedCredential;
  readonly propsValue: Readonly<Record<string, unknown>>;
  readonly fetchImpl: FetchImplementation;
  readonly routes?: readonly PieceFetchRoute[];
  readonly boundary?: PieceExecutionBoundary;
  readonly store?: MemoryPieceStore;
  readonly projectId?: string;
  readonly userId?: string;
  readonly apiKeyField?: string;
}

function actionContext(
  options: ExecutePieceActionOptions,
  auth: unknown,
  routedFetch: FetchImplementation,
): Readonly<Record<string, unknown>> {
  const store = options.store ?? new MemoryPieceStore();
  const projectId = options.projectId ?? "bridge-project";
  return {
    auth,
    propsValue: { ...options.propsValue },
    store,
    httpClient: createFetchHttpClient(routedFetch),
    connections: {
      get: async () => unsupportedContextApi("connections.get"),
    },
    files: {
      write: async () => unsupportedContextApi("files.write"),
    },
    server: {
      apiUrl: "http://eyeball.local",
      publicUrl: "http://eyeball.local",
      token: "bridge-action-context",
    },
    project: {
      id: projectId,
      externalId: async () => undefined,
    },
    flows: {
      current: { id: "bridge-flow", version: { id: "bridge-version" } },
      list: async () => unsupportedContextApi("flows.list"),
    },
    step: { name: "bridge-action", type: "PIECE" },
    tags: { add: async () => unsupportedContextApi("tags.add") },
    output: { update: async () => unsupportedContextApi("output.update") },
    run: {
      id: "bridge-run",
      stop: () => unsupportedContextApi("run.stop"),
      respond: () => unsupportedContextApi("run.respond"),
      createWaitpoint: async () => unsupportedContextApi("run.createWaitpoint"),
      waitForWaitpoint: () => unsupportedContextApi("run.waitForWaitpoint"),
    },
    agent: {
      tools: async () => unsupportedContextApi("agent.tools"),
    },
    executionType: "BEGIN",
    runId: "bridge-run",
    userId: options.userId ?? "bridge-user",
  };
}

/** Executes one Activepieces action through the compatibility context. */
export async function executePieceAction(
  options: ExecutePieceActionOptions,
): Promise<unknown> {
  const auth = resolvedCredentialToPieceAuth(
    options.credential,
    options.piece,
    options.apiKeyField === undefined
      ? {}
      : { apiKeyField: options.apiKeyField },
  );
  const routes = options.routes ?? [];
  const routedFetch = createRoutedFetch(options.fetchImpl, routes);
  return runInsidePieceBoundary(
    { fetchImpl: options.fetchImpl, routes },
    options.boundary,
    routedFetch,
    () => options.action.run(actionContext(options, auth, routedFetch)),
  );
}

function toJsonValue(value: unknown, seen: Set<object>): JsonValue {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return null;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(
        "Activepieces returned a circular value that cannot cross the JSON boundary.",
      );
    }
    seen.add(value);
    const result = value.map((item) => toJsonValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) {
    return String(value);
  }
  if (seen.has(value)) {
    throw new Error(
      "Activepieces returned a circular value that cannot cross the JSON boundary.",
    );
  }
  seen.add(value);
  const result: Record<string, JsonValue> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item !== undefined && typeof item !== "function") {
      result[name] = toJsonValue(item, seen);
    }
  }
  seen.delete(value);
  return result;
}

/** Converts SDK responses and other piece results to eyeball's JSON boundary. */
export function normalizePieceOutput(value: unknown): JsonValue {
  if (
    isRecord(value) &&
    typeof value.status === "number" &&
    Object.hasOwn(value, "data")
  ) {
    return toJsonValue(value.data, new Set());
  }
  if (
    isRecord(value) &&
    typeof value.status === "number" &&
    Object.hasOwn(value, "body")
  ) {
    return toJsonValue(value.body, new Set());
  }
  return toJsonValue(value, new Set());
}

export interface ActivepiecesToolkitAdapterOptions {
  readonly toolkitSlug: ToolkitSlug;
  readonly piece: ActivepiecesPiece;
  /** Canonical operation name to Activepieces action name. */
  readonly actionMap: Readonly<Record<string, string>>;
  readonly sourceOrigins: readonly string[];
  readonly boundary?: PieceExecutionBoundary;
  readonly apiKeyField?: string;
}

/** Experimental adapter proving that an Activepieces action fits AdapterContext. */
export class ActivepiecesToolkitAdapter implements ToolkitAdapter {
  readonly toolkitSlug: ToolkitSlug;
  readonly #options: ActivepiecesToolkitAdapterOptions;

  constructor(options: ActivepiecesToolkitAdapterOptions) {
    this.toolkitSlug = options.toolkitSlug;
    this.#options = options;
  }

  async execute(context: AdapterContext): Promise<JsonValue> {
    const canonicalOperation = context.tool.name.split(".").at(-1);
    const actionName =
      canonicalOperation === undefined
        ? undefined
        : this.#options.actionMap[canonicalOperation];
    if (actionName === undefined) {
      throw new Error(
        `No Activepieces action mapping for ${context.tool.name}.`,
      );
    }
    const action = this.#options.piece.getAction(actionName);
    if (action === undefined) {
      throw new Error(`Activepieces action not found: ${actionName}`);
    }
    const routes = this.#options.sourceOrigins.map((fromOrigin) => ({
      fromOrigin,
      toBaseUrl: context.baseUrl,
    }));
    const output = await executePieceAction({
      piece: this.#options.piece,
      action,
      credential: context.credential,
      propsValue: context.canonicalInput,
      fetchImpl: context.fetchImpl,
      routes,
      projectId: context.projectId,
      userId: context.userId,
      ...(this.#options.boundary === undefined
        ? {}
        : { boundary: this.#options.boundary }),
      ...(this.#options.apiKeyField === undefined
        ? {}
        : { apiKeyField: this.#options.apiKeyField }),
    });
    return normalizePieceOutput(output);
  }
}
