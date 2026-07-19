import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  type CreatedWebhookEndpoint,
  isWebhookSubscriptionEventType,
  type RotatedWebhookSecret,
  type WebhookEndpoint,
  type WebhookEndpointPage,
  type WebhookSubscriptionEventType,
} from "@eyeball/core";

export interface CreateWebhookEndpointInput {
  url: string;
  events: readonly WebhookSubscriptionEventType[];
  active: boolean;
  createdAt: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: readonly WebhookSubscriptionEventType[];
  active?: boolean;
  updatedAt: string;
}

export interface ListWebhookEndpointsInput {
  cursor?: string;
  limit: number;
}

export interface StoredWebhookEndpoint extends WebhookEndpoint {
  secret: string;
}

export interface WebhookEndpointStore {
  create(
    projectId: string,
    input: CreateWebhookEndpointInput,
  ): Promise<CreatedWebhookEndpoint>;
  get(
    projectId: string,
    endpointId: string,
  ): Promise<WebhookEndpoint | undefined>;
  getForDelivery(
    projectId: string,
    endpointId: string,
  ): Promise<StoredWebhookEndpoint | undefined>;
  list(
    projectId: string,
    input: ListWebhookEndpointsInput,
  ): Promise<WebhookEndpointPage>;
  listForDelivery(projectId: string): Promise<readonly StoredWebhookEndpoint[]>;
  update(
    projectId: string,
    endpointId: string,
    input: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpoint | undefined>;
  rotateSecret(
    projectId: string,
    endpointId: string,
    rotatedAt: string,
  ): Promise<RotatedWebhookSecret | undefined>;
  delete(projectId: string, endpointId: string): Promise<boolean>;
}

export interface InMemoryWebhookEndpointStoreOptions {
  endpointIdFactory?: () => string;
  secretFactory?: () => string;
  /** Development-only escape hatch for cleartext receivers. */
  allowInsecureHttp?: boolean;
  /** Development-only escape hatch for loopback and literal private addresses. */
  allowPrivateNetwork?: boolean;
}

export class WebhookEndpointInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookEndpointInputError";
  }
}

export class InvalidWebhookCursorError extends WebhookEndpointInputError {
  constructor() {
    super("Webhook cursor is invalid.");
    this.name = "InvalidWebhookCursorError";
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function endpointId(): string {
  return `whe_${randomUUID().replaceAll("-", "")}`;
}

function endpointSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function secretPrefix(secret: string): string {
  return secret.slice(0, Math.min(secret.length, 14));
}

export function publicEndpoint(
  endpoint: StoredWebhookEndpoint,
): WebhookEndpoint {
  const { secret: _secret, ...result } = endpoint;
  return result;
}

export function validTimestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new WebhookEndpointInputError(`${field} must be a timestamp.`);
  }
}

export function validateEvents(
  events: readonly WebhookSubscriptionEventType[],
): void {
  if (events.length === 0) {
    throw new WebhookEndpointInputError(
      "Webhook endpoints must subscribe to at least one event.",
    );
  }
  if (
    new Set(events).size !== events.length ||
    events.some((event) => !isWebhookSubscriptionEventType(event))
  ) {
    throw new WebhookEndpointInputError(
      "Webhook endpoint events are invalid or duplicated.",
    );
  }
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function privateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("::") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89abcdef]/u.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function privateHostname(hostname: string): boolean {
  const normalized = hostname
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }
  const version = isIP(normalized);
  return (
    (version === 4 && privateIpv4(normalized)) ||
    (version === 6 && privateIpv6(normalized))
  );
}

export function normalizedUrl(
  value: string,
  options: Pick<
    InMemoryWebhookEndpointStoreOptions,
    "allowInsecureHttp" | "allowPrivateNetwork"
  >,
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new WebhookEndpointInputError(
      "Webhook URL must be an absolute HTTPS URL.",
    );
  }
  const protocolAllowed =
    url.protocol === "https:" ||
    (options.allowInsecureHttp === true && url.protocol === "http:");
  if (
    !protocolAllowed ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new WebhookEndpointInputError(
      "Webhook URL must be HTTPS without credentials or a fragment.",
    );
  }
  if (options.allowPrivateNetwork !== true && privateHostname(url.hostname)) {
    throw new WebhookEndpointInputError(
      "Webhook URL must not target loopback or a literal private address.",
    );
  }
  return url.toString();
}

export function endpointCursorAfter(endpointId: string): string {
  return Buffer.from(JSON.stringify({ after: endpointId }), "utf8").toString(
    "base64url",
  );
}

export function endpointIdFromCursor(cursor: string): string {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("after" in parsed) ||
      typeof parsed.after !== "string" ||
      parsed.after.length === 0
    ) {
      throw new InvalidWebhookCursorError();
    }
    return parsed.after;
  } catch (error) {
    if (error instanceof InvalidWebhookCursorError) throw error;
    throw new InvalidWebhookCursorError();
  }
}

export function validateListInput(input: ListWebhookEndpointsInput): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new WebhookEndpointInputError(
      "Webhook list limit must be an integer from 1 through 100.",
    );
  }
}

/** Process-local project endpoint registry. Durable deployments replace this store. */
export class InMemoryWebhookEndpointStore implements WebhookEndpointStore {
  readonly #projects = new Map<string, Map<string, StoredWebhookEndpoint>>();
  readonly #endpointIdFactory: () => string;
  readonly #secretFactory: () => string;
  readonly #allowInsecureHttp: boolean;
  readonly #allowPrivateNetwork: boolean;

  constructor(options: InMemoryWebhookEndpointStoreOptions = {}) {
    this.#endpointIdFactory = options.endpointIdFactory ?? endpointId;
    this.#secretFactory = options.secretFactory ?? endpointSecret;
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  }

  async create(
    projectId: string,
    input: CreateWebhookEndpointInput,
  ): Promise<CreatedWebhookEndpoint> {
    if (projectId.trim().length === 0) {
      throw new WebhookEndpointInputError(
        "Webhook project ID must not be empty.",
      );
    }
    validateEvents(input.events);
    validTimestamp(input.createdAt, "Webhook endpoint createdAt");
    const url = normalizedUrl(input.url, {
      allowInsecureHttp: this.#allowInsecureHttp,
      allowPrivateNetwork: this.#allowPrivateNetwork,
    });
    const project = this.#project(projectId);
    const generatedEndpointId = this.#endpointIdFactory();
    if (generatedEndpointId.trim().length === 0) {
      throw new Error("Webhook endpoint ID factory returned an empty value.");
    }
    if (project.has(generatedEndpointId)) {
      throw new Error(`Duplicate webhook endpoint ID: ${generatedEndpointId}`);
    }
    const secret = this.#newSecret();
    const endpoint: StoredWebhookEndpoint = {
      endpointId: generatedEndpointId,
      url,
      secret,
      secretPrefix: secretPrefix(secret),
      events: [...input.events],
      active: input.active,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    project.set(endpoint.endpointId, copy(endpoint));
    return copy({ ...publicEndpoint(endpoint), secret });
  }

  async get(
    projectId: string,
    endpointId: string,
  ): Promise<WebhookEndpoint | undefined> {
    const endpoint = this.#projects.get(projectId)?.get(endpointId);
    return endpoint === undefined ? undefined : copy(publicEndpoint(endpoint));
  }

  async getForDelivery(
    projectId: string,
    endpointId: string,
  ): Promise<StoredWebhookEndpoint | undefined> {
    const endpoint = this.#projects.get(projectId)?.get(endpointId);
    return endpoint === undefined ? undefined : copy(endpoint);
  }

  async list(
    projectId: string,
    input: ListWebhookEndpointsInput,
  ): Promise<WebhookEndpointPage> {
    validateListInput(input);
    const all = [...(this.#projects.get(projectId)?.values() ?? [])].reverse();
    let offset = 0;
    if (input.cursor !== undefined) {
      const after = endpointIdFromCursor(input.cursor);
      const index = all.findIndex((endpoint) => endpoint.endpointId === after);
      if (index === -1) throw new InvalidWebhookCursorError();
      offset = index + 1;
    }
    const webhooks = all
      .slice(offset, offset + input.limit)
      .map((endpoint) => copy(publicEndpoint(endpoint)));
    const nextOffset = offset + webhooks.length;
    const last = webhooks.at(-1);
    return {
      webhooks,
      ...(nextOffset < all.length && last !== undefined
        ? { nextCursor: endpointCursorAfter(last.endpointId) }
        : {}),
    };
  }

  async listForDelivery(
    projectId: string,
  ): Promise<readonly StoredWebhookEndpoint[]> {
    return [...(this.#projects.get(projectId)?.values() ?? [])].map(copy);
  }

  async update(
    projectId: string,
    endpointId: string,
    input: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpoint | undefined> {
    const endpoint = this.#projects.get(projectId)?.get(endpointId);
    if (endpoint === undefined) return undefined;
    if (
      input.url === undefined &&
      input.events === undefined &&
      input.active === undefined
    ) {
      throw new WebhookEndpointInputError(
        "Webhook update must change url, events, or active.",
      );
    }
    validTimestamp(input.updatedAt, "Webhook endpoint updatedAt");
    if (input.events !== undefined) validateEvents(input.events);
    const updated: StoredWebhookEndpoint = {
      ...endpoint,
      ...(input.url === undefined
        ? {}
        : {
            url: normalizedUrl(input.url, {
              allowInsecureHttp: this.#allowInsecureHttp,
              allowPrivateNetwork: this.#allowPrivateNetwork,
            }),
          }),
      ...(input.events === undefined ? {} : { events: [...input.events] }),
      ...(input.active === undefined ? {} : { active: input.active }),
      updatedAt: input.updatedAt,
    };
    this.#projects.get(projectId)?.set(endpointId, copy(updated));
    return copy(publicEndpoint(updated));
  }

  async rotateSecret(
    projectId: string,
    endpointId: string,
    rotatedAt: string,
  ): Promise<RotatedWebhookSecret | undefined> {
    const endpoint = this.#projects.get(projectId)?.get(endpointId);
    if (endpoint === undefined) return undefined;
    validTimestamp(rotatedAt, "Webhook secret rotatedAt");
    const secret = this.#newSecret();
    const prefix = secretPrefix(secret);
    const updated: StoredWebhookEndpoint = {
      ...endpoint,
      secret,
      secretPrefix: prefix,
      updatedAt: rotatedAt,
    };
    this.#projects.get(projectId)?.set(endpointId, copy(updated));
    return {
      endpointId,
      secretPrefix: prefix,
      secret,
      rotatedAt,
    };
  }

  async delete(projectId: string, endpointId: string): Promise<boolean> {
    const project = this.#projects.get(projectId);
    if (project === undefined) return false;
    const deleted = project.delete(endpointId);
    if (project.size === 0) this.#projects.delete(projectId);
    return deleted;
  }

  #newSecret(): string {
    const secret = this.#secretFactory();
    if (secret.trim().length === 0) {
      throw new Error("Webhook secret factory returned an empty value.");
    }
    return secret;
  }

  #project(projectId: string): Map<string, StoredWebhookEndpoint> {
    const existing = this.#projects.get(projectId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredWebhookEndpoint>();
    this.#projects.set(projectId, created);
    return created;
  }
}
