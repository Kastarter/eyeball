import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  type ApiKeyCredential,
  type BasicCredential,
  type CredentialContext,
  type CredentialProvider,
  CredentialProviderError,
  type CredentialRefreshContext,
  type NoCredential,
  type OAuth2Credential,
  type ResolvedCredential,
} from "./credentials.js";
import type { ConnectionId } from "./types/execution.js";
import type { ToolkitSlug } from "./types/tool.js";

const VAULT_VERSION = 1 as const;
const NONCE_BYTES = 12;
const NONCE_SEED_BYTES = 24;
const AUTH_TAG_BYTES = 16;
const VAULT_KEY_BYTES = 32;

export type OAuthClientAuthentication = "body" | "basic";
export type OAuthTokenRequestEncoding = "form" | "json";

export interface OAuthTokenEndpointConfig {
  tokenUrl: string;
  clientAuthentication?: OAuthClientAuthentication;
  requestEncoding?: OAuthTokenRequestEncoding;
  refreshParameters?: Readonly<Record<string, string>>;
}

export interface LocalVaultOAuth2Credential {
  type: "oauth2";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: readonly string[];
  tokenType?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
}

export type LocalVaultStoredCredential =
  | LocalVaultOAuth2Credential
  | Omit<ApiKeyCredential, "connectionId">
  | Omit<BasicCredential, "connectionId">
  | Omit<NoCredential, "connectionId">;

export interface LocalVaultRecordSelector {
  userId: string;
  toolkitSlug: ToolkitSlug;
  connectionId?: ConnectionId;
}

export interface LocalVaultPutInput extends LocalVaultRecordSelector {
  credential: LocalVaultStoredCredential;
}

export interface LocalVaultRecordSummary extends LocalVaultRecordSelector {
  type: LocalVaultStoredCredential["type"];
  expiresAt?: string;
  scopes?: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface LocalVaultListFilter {
  userId?: string;
  toolkitSlug?: ToolkitSlug;
}

export interface LocalVaultCredentialProviderOptions {
  filePath: string;
  allowedProjectId: string;
  oauth?: Readonly<Record<ToolkitSlug, OAuthTokenEndpointConfig>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: readonly string[];
  tokenType?: string;
}

export class OAuthTokenRequestError extends Error {
  readonly status: number | undefined;
  readonly oauthCode: string | undefined;

  constructor(
    message: string,
    options: { status?: number; oauthCode?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "OAuthTokenRequestError";
    this.status = options.status;
    this.oauthCode = options.oauthCode;
  }
}

export interface RequestOAuthTokenOptions {
  endpoint: OAuthTokenEndpointConfig;
  clientId: string;
  clientSecret?: string;
  parameters: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface VaultRecordKey {
  userId: string;
  toolkitSlug: ToolkitSlug;
  connectionId?: ConnectionId;
}

interface EncryptedVaultRecord {
  id: string;
  key: VaultRecordKey;
  revision: number;
  nonceSeed: string;
  ciphertext: string;
  authTag: string;
  createdAt: string;
  updatedAt: string;
}

interface VaultFile {
  version: typeof VAULT_VERSION;
  salt: string;
  records: EncryptedVaultRecord[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  description: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`Invalid local vault ${description}.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  description: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredString(value, description);
}

function stringRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, string>> {
  if (!isObject(value)) {
    throw new Error(`Invalid local vault ${description}.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      requiredString(item, `${description} field ${key}`),
    ]),
  );
}

function optionalStringRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, string>> | undefined {
  return value === undefined ? undefined : stringRecord(value, description);
}

function optionalScopes(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Invalid local vault OAuth scopes.");
  }
  return value.map((scope) => requiredString(scope, "OAuth scope"));
}

function parseStoredCredential(value: unknown): LocalVaultStoredCredential {
  if (!isObject(value)) {
    throw new Error("Invalid encrypted local vault credential.");
  }
  switch (value.type) {
    case "oauth2": {
      const refreshToken = optionalString(
        value.refreshToken,
        "OAuth refresh token",
      );
      const expiresAt = optionalString(value.expiresAt, "OAuth expiry");
      const scopes = optionalScopes(value.scopes);
      const tokenType = optionalString(value.tokenType, "OAuth token type");
      const clientSecret = optionalString(
        value.clientSecret,
        "OAuth client secret",
      );
      const redirectUri = optionalString(
        value.redirectUri,
        "OAuth redirect URI",
      );
      return {
        type: "oauth2",
        accessToken: requiredString(value.accessToken, "OAuth access token"),
        clientId: requiredString(value.clientId, "OAuth client ID"),
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(scopes === undefined ? {} : { scopes }),
        ...(tokenType === undefined ? {} : { tokenType }),
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(redirectUri === undefined ? {} : { redirectUri }),
      };
    }
    case "api_key":
      return {
        type: "api_key",
        values: stringRecord(value.values, "API key values"),
      };
    case "basic": {
      const parameters = optionalStringRecord(
        value.parameters,
        "Basic parameters",
      );
      return {
        type: "basic",
        username: requiredString(value.username, "Basic username"),
        password: requiredString(value.password, "Basic password"),
        ...(parameters === undefined ? {} : { parameters }),
      };
    }
    case "none":
      return { type: "none" };
    default:
      throw new Error("Invalid encrypted local vault credential type.");
  }
}

function parseRecordKey(value: unknown): VaultRecordKey {
  if (!isObject(value)) {
    throw new Error("Invalid local vault record key.");
  }
  const connectionId = optionalString(value.connectionId, "connection ID");
  return {
    userId: requiredString(value.userId, "user ID"),
    toolkitSlug: requiredString(
      value.toolkitSlug,
      "toolkit slug",
    ) as ToolkitSlug,
    ...(connectionId === undefined
      ? {}
      : { connectionId: connectionId as ConnectionId }),
  };
}

function parseVaultFile(value: unknown): VaultFile {
  if (
    !isObject(value) ||
    value.version !== VAULT_VERSION ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Invalid or unsupported local vault file.");
  }
  const salt = Buffer.from(requiredString(value.salt, "salt"), "base64");
  if (salt.length < 16) {
    throw new Error("Invalid local vault salt.");
  }
  const ids = new Set<string>();
  const records = value.records.map((item): EncryptedVaultRecord => {
    if (!isObject(item)) {
      throw new Error("Invalid local vault record.");
    }
    const id = requiredString(item.id, "record ID");
    if (ids.has(id)) {
      throw new Error("Local vault contains a duplicate record ID.");
    }
    ids.add(id);
    if (!Number.isSafeInteger(item.revision) || Number(item.revision) < 1) {
      throw new Error("Invalid local vault record revision.");
    }
    const nonceSeed = requiredString(item.nonceSeed, "nonce seed");
    if (Buffer.from(nonceSeed, "base64").length !== NONCE_SEED_BYTES) {
      throw new Error("Invalid local vault nonce seed.");
    }
    return {
      id,
      key: parseRecordKey(item.key),
      revision: Number(item.revision),
      nonceSeed,
      ciphertext: requiredString(item.ciphertext, "ciphertext"),
      authTag: requiredString(item.authTag, "authentication tag"),
      createdAt: requiredString(item.createdAt, "creation timestamp"),
      updatedAt: requiredString(item.updatedAt, "update timestamp"),
    };
  });
  return { version: VAULT_VERSION, salt: value.salt as string, records };
}

function decodeVaultKey(value: string | undefined): Buffer {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      "EYEBALL_VAULT_KEY is required and must be a base64-encoded 32-byte key. Run `pnpm eyeball-auth init` to generate one.",
    );
  }
  const normalized = value.trim();
  const key = Buffer.from(normalized, "base64");
  if (
    key.length !== VAULT_KEY_BYTES ||
    key.toString("base64").replace(/=+$/u, "") !==
      normalized.replace(/=+$/u, "")
  ) {
    throw new Error(
      "EYEBALL_VAULT_KEY must be a base64-encoded 32-byte key. Run `pnpm eyeball-auth init` to generate one.",
    );
  }
  return key;
}

function recordId(key: VaultRecordKey): string {
  return createHash("sha256")
    .update(
      JSON.stringify([key.userId, key.toolkitSlug, key.connectionId ?? null]),
    )
    .digest("base64url");
}

function recordAad(
  record: Pick<EncryptedVaultRecord, "id" | "key" | "revision" | "nonceSeed">,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: VAULT_VERSION,
      id: record.id,
      key: [
        record.key.userId,
        record.key.toolkitSlug,
        record.key.connectionId ?? null,
      ],
      revision: record.revision,
      nonceSeed: record.nonceSeed,
    }),
  );
}

function deriveNonce(
  key: Buffer,
  salt: string,
  id: string,
  revision: number,
  nonceSeed: string,
): Buffer {
  return createHmac("sha256", key)
    .update("eyeball-local-vault-aes-gcm-nonce-v1\0")
    .update(salt)
    .update("\0")
    .update(id)
    .update("\0")
    .update(String(revision))
    .update("\0")
    .update(nonceSeed)
    .digest()
    .subarray(0, NONCE_BYTES);
}

function encryptCredential(
  credential: LocalVaultStoredCredential,
  options: {
    key: Buffer;
    salt: string;
    record: Pick<EncryptedVaultRecord, "id" | "key" | "revision" | "nonceSeed">;
  },
): Pick<EncryptedVaultRecord, "ciphertext" | "authTag"> {
  const nonce = deriveNonce(
    options.key,
    options.salt,
    options.record.id,
    options.record.revision,
    options.record.nonceSeed,
  );
  const cipher = createCipheriv("aes-256-gcm", options.key, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(recordAad(options.record));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptCredential(
  record: EncryptedVaultRecord,
  key: Buffer,
  salt: string,
): LocalVaultStoredCredential {
  try {
    const nonce = deriveNonce(
      key,
      salt,
      record.id,
      record.revision,
      record.nonceSeed,
    );
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAAD(recordAad(record));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    return parseStoredCredential(JSON.parse(plaintext.toString("utf8")));
  } catch (error) {
    throw new Error(
      "Unable to decrypt a local vault record. Check EYEBALL_VAULT_KEY and the vault file integrity.",
      { cause: error },
    );
  }
}

async function writeVaultFile(
  filePath: string,
  vault: VaultFile,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${dirname(filePath)}/.${basename(filePath)}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(vault, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function generateLocalVaultKey(): string {
  return randomBytes(VAULT_KEY_BYTES).toString("base64");
}

export async function initializeLocalVaultFile(
  filePath: string,
  options: { overwrite?: boolean } = {},
): Promise<string> {
  const absolutePath = resolve(filePath);
  if (existsSync(absolutePath) && options.overwrite !== true) {
    throw new Error(
      `Local vault already exists at ${absolutePath}; refusing to overwrite it.`,
    );
  }
  await writeVaultFile(absolutePath, {
    version: VAULT_VERSION,
    salt: randomBytes(24).toString("base64"),
    records: [],
  });
  return absolutePath;
}

function safeOAuthCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,80}$/iu.test(value)
    ? value
    : undefined;
}

function parseTokenSet(value: unknown, now: Date): OAuthTokenSet {
  if (!isObject(value)) {
    throw new OAuthTokenRequestError(
      "The OAuth token endpoint returned invalid JSON.",
    );
  }
  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    const oauthCode = safeOAuthCode(value.error);
    throw new OAuthTokenRequestError(
      `The OAuth token endpoint did not return an access token${oauthCode === undefined ? "." : ` (${oauthCode}).`}`,
      oauthCode === undefined ? {} : { oauthCode },
    );
  }
  const refreshToken = optionalString(
    value.refresh_token,
    "token response refresh token",
  );
  const tokenType = optionalString(value.token_type, "token response type");
  let expiresAt: string | undefined;
  if (
    typeof value.expires_at === "string" &&
    !Number.isNaN(Date.parse(value.expires_at))
  ) {
    expiresAt = new Date(value.expires_at).toISOString();
  } else if (
    (typeof value.expires_in === "number" ||
      typeof value.expires_in === "string") &&
    Number.isFinite(Number(value.expires_in)) &&
    Number(value.expires_in) > 0
  ) {
    expiresAt = new Date(
      now.getTime() + Number(value.expires_in) * 1_000,
    ).toISOString();
  }
  const scopeValue = value.scope ?? value.scopes;
  const scopes =
    typeof scopeValue === "string"
      ? scopeValue.split(/[\s,]+/u).filter((scope) => scope.length > 0)
      : Array.isArray(scopeValue)
        ? scopeValue.map((scope) =>
            requiredString(scope, "token response scope"),
          )
        : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(scopes === undefined ? {} : { scopes }),
    ...(tokenType === undefined ? {} : { tokenType }),
  };
}

export async function requestOAuthToken(
  options: RequestOAuthTokenOptions,
): Promise<OAuthTokenSet> {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint.tokenUrl);
  } catch (error) {
    throw new OAuthTokenRequestError(
      "The OAuth token endpoint URL is invalid.",
      {
        cause: error,
      },
    );
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new OAuthTokenRequestError(
      "The OAuth token endpoint must use HTTP or HTTPS.",
    );
  }
  const clientAuthentication = options.endpoint.clientAuthentication ?? "body";
  const values: Record<string, string> = { ...options.parameters };
  const headers = new Headers({ Accept: "application/json" });
  if (clientAuthentication === "basic") {
    if (options.clientSecret === undefined) {
      throw new OAuthTokenRequestError(
        "This OAuth token endpoint requires a client secret.",
      );
    }
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64")}`,
    );
  } else {
    values.client_id = options.clientId;
    if (options.clientSecret !== undefined) {
      values.client_secret = options.clientSecret;
    }
  }

  const requestEncoding = options.endpoint.requestEncoding ?? "form";
  const body =
    requestEncoding === "json"
      ? JSON.stringify(values)
      : new URLSearchParams(values).toString();
  headers.set(
    "Content-Type",
    requestEncoding === "json"
      ? "application/json"
      : "application/x-www-form-urlencoded",
  );

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers,
      body,
    });
  } catch (error) {
    throw new OAuthTokenRequestError(
      "The OAuth token endpoint could not be reached.",
      {
        cause: error,
      },
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new OAuthTokenRequestError(
      `The OAuth token endpoint returned HTTP ${response.status} with an invalid JSON body.`,
      { status: response.status, cause: error },
    );
  }
  if (!response.ok) {
    const oauthCode = isObject(value) ? safeOAuthCode(value.error) : undefined;
    throw new OAuthTokenRequestError(
      `The OAuth token endpoint returned HTTP ${response.status}${oauthCode === undefined ? "." : ` (${oauthCode}).`}`,
      {
        status: response.status,
        ...(oauthCode === undefined ? {} : { oauthCode }),
      },
    );
  }
  return parseTokenSet(value, (options.now ?? (() => new Date()))());
}

function authMissing(message: string): CredentialProviderError {
  return new CredentialProviderError({
    code: "auth_missing",
    message,
    retryable: false,
  });
}

function reconnectMessage(selector: LocalVaultRecordSelector): string {
  return `Reconnect ${selector.toolkitSlug} with \`pnpm eyeball-auth add ${selector.toolkitSlug} --user ${selector.userId}\`.`;
}

function resolvedCredential(
  stored: LocalVaultStoredCredential,
  connectionId: ConnectionId | undefined,
): ResolvedCredential {
  const selected = connectionId === undefined ? {} : { connectionId };
  switch (stored.type) {
    case "oauth2":
      return {
        type: "oauth2",
        accessToken: stored.accessToken,
        ...selected,
        ...(stored.expiresAt === undefined
          ? {}
          : { expiresAt: stored.expiresAt }),
        ...(stored.scopes === undefined ? {} : { scopes: [...stored.scopes] }),
        ...(stored.tokenType === undefined
          ? {}
          : { tokenType: stored.tokenType }),
      };
    case "api_key":
      return { type: "api_key", values: { ...stored.values }, ...selected };
    case "basic":
      return {
        type: "basic",
        username: stored.username,
        password: stored.password,
        ...selected,
        ...(stored.parameters === undefined
          ? {}
          : { parameters: { ...stored.parameters } }),
      };
    case "none":
      return { type: "none", ...selected };
  }
}

function isExpired(credential: LocalVaultOAuth2Credential, now: Date): boolean {
  return (
    credential.expiresAt !== undefined &&
    (Number.isNaN(Date.parse(credential.expiresAt)) ||
      Date.parse(credential.expiresAt) <= now.getTime())
  );
}

export class LocalVaultCredentialProvider implements CredentialProvider {
  readonly kind = "local-vault" as const;
  readonly filePath: string;
  readonly #allowedProjectId: string;
  readonly #oauth: Readonly<Record<ToolkitSlug, OAuthTokenEndpointConfig>>;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => Date;
  readonly #key: Buffer;
  readonly #refreshes = new Map<string, Promise<OAuth2Credential>>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: LocalVaultCredentialProviderOptions) {
    if (options.allowedProjectId.trim().length === 0) {
      throw new Error("Local vault allowedProjectId must not be empty.");
    }
    if (options.filePath.trim().length === 0) {
      throw new Error(
        "EYEBALL_VAULT_PATH must point to a local vault JSON file.",
      );
    }
    this.filePath = resolve(options.filePath);
    this.#allowedProjectId = options.allowedProjectId;
    this.#oauth = options.oauth ?? {};
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#key = decodeVaultKey((options.env ?? process.env).EYEBALL_VAULT_KEY);
    if (!existsSync(this.filePath)) {
      throw new Error(
        `Local vault file not found at ${this.filePath}. Run \`pnpm eyeball-auth init --vault ${this.filePath}\` first.`,
      );
    }
  }

  async #read(): Promise<VaultFile> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read local vault at ${this.filePath}.`, {
        cause: error,
      });
    }
    try {
      return parseVaultFile(JSON.parse(source));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Local vault at ${this.filePath} is not valid JSON.`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  #withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertProject(projectId: string): void {
    if (projectId !== this.#allowedProjectId) {
      throw authMissing(
        "No usable connection exists for this project and user.",
      );
    }
  }

  #select(
    vault: VaultFile,
    selector: LocalVaultRecordSelector,
  ): EncryptedVaultRecord {
    const candidates = vault.records.filter(
      (record) =>
        record.key.userId === selector.userId &&
        record.key.toolkitSlug === selector.toolkitSlug,
    );
    if (selector.connectionId !== undefined) {
      const match = candidates.find(
        (record) => record.key.connectionId === selector.connectionId,
      );
      if (match !== undefined) {
        return match;
      }
      throw authMissing(
        "No usable local vault connection exists for this project, user, and toolkit.",
      );
    }
    if (candidates.length === 1 && candidates[0] !== undefined) {
      return candidates[0];
    }
    const defaults = candidates.filter(
      (record) => record.key.connectionId === undefined,
    );
    if (defaults.length === 1 && defaults[0] !== undefined) {
      return defaults[0];
    }
    throw authMissing(
      candidates.length === 0
        ? `No usable ${selector.toolkitSlug} credential is stored in the local vault.`
        : `Multiple ${selector.toolkitSlug} connections exist; provide connectionId.`,
    );
  }

  async put(input: LocalVaultPutInput): Promise<void> {
    parseStoredCredential(input.credential);
    await this.#withMutation(async () => {
      const vault = await this.#read();
      const key: VaultRecordKey = {
        userId: requiredString(input.userId, "user ID"),
        toolkitSlug: input.toolkitSlug,
        ...(input.connectionId === undefined
          ? {}
          : { connectionId: input.connectionId }),
      };
      const id = recordId(key);
      const existingIndex = vault.records.findIndex(
        (record) => record.id === id,
      );
      const existing =
        existingIndex === -1 ? undefined : vault.records[existingIndex];
      const now = this.#now().toISOString();
      const recordBase = {
        id,
        key,
        revision: (existing?.revision ?? 0) + 1,
        nonceSeed: randomBytes(NONCE_SEED_BYTES).toString("base64"),
      };
      const encrypted = encryptCredential(input.credential, {
        key: this.#key,
        salt: vault.salt,
        record: recordBase,
      });
      const record: EncryptedVaultRecord = {
        ...recordBase,
        ...encrypted,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existingIndex === -1) {
        vault.records.push(record);
      } else {
        vault.records[existingIndex] = record;
      }
      await writeVaultFile(this.filePath, vault);
    });
  }

  async list(
    filter: LocalVaultListFilter = {},
  ): Promise<LocalVaultRecordSummary[]> {
    await this.#mutationTail;
    const vault = await this.#read();
    return vault.records
      .filter(
        (record) =>
          (filter.userId === undefined ||
            record.key.userId === filter.userId) &&
          (filter.toolkitSlug === undefined ||
            record.key.toolkitSlug === filter.toolkitSlug),
      )
      .map((record) => {
        const credential = decryptCredential(record, this.#key, vault.salt);
        return {
          ...record.key,
          type: credential.type,
          ...(credential.type !== "oauth2" || credential.expiresAt === undefined
            ? {}
            : { expiresAt: credential.expiresAt }),
          ...(credential.type !== "oauth2" || credential.scopes === undefined
            ? {}
            : { scopes: [...credential.scopes] }),
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
      })
      .sort((left, right) =>
        `${left.userId}\0${left.toolkitSlug}\0${left.connectionId ?? ""}`.localeCompare(
          `${right.userId}\0${right.toolkitSlug}\0${right.connectionId ?? ""}`,
        ),
      );
  }

  async remove(selector: LocalVaultRecordSelector): Promise<boolean> {
    return this.#withMutation(async () => {
      const vault = await this.#read();
      const id = recordId(selector);
      const remaining = vault.records.filter((record) => record.id !== id);
      if (remaining.length === vault.records.length) {
        return false;
      }
      await writeVaultFile(this.filePath, { ...vault, records: remaining });
      return true;
    });
  }

  async resolve(context: CredentialContext): Promise<ResolvedCredential> {
    this.#assertProject(context.projectId);
    await this.#mutationTail;
    const vault = await this.#read();
    const record = this.#select(vault, context);
    const credential = decryptCredential(record, this.#key, vault.salt);
    if (credential.type !== "oauth2" || !isExpired(credential, this.#now())) {
      return resolvedCredential(credential, record.key.connectionId);
    }
    return this.#deduplicatedRefresh(record.id);
  }

  async refresh(context: CredentialRefreshContext): Promise<OAuth2Credential> {
    this.#assertProject(context.projectId);
    await this.#mutationTail;
    const vault = await this.#read();
    const record = this.#select(vault, context);
    return this.#deduplicatedRefresh(record.id, true);
  }

  #deduplicatedRefresh(id: string, force = false): Promise<OAuth2Credential> {
    const existing = this.#refreshes.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const refresh = this.#refreshAndPersist(id, force).finally(() => {
      if (this.#refreshes.get(id) === refresh) {
        this.#refreshes.delete(id);
      }
    });
    this.#refreshes.set(id, refresh);
    return refresh;
  }

  #refreshAndPersist(id: string, force: boolean): Promise<OAuth2Credential> {
    return this.#withMutation(async () => {
      const vault = await this.#read();
      const index = vault.records.findIndex((candidate) => candidate.id === id);
      const record = index === -1 ? undefined : vault.records[index];
      if (record === undefined) {
        throw authMissing(
          "The local vault connection was removed before it could be refreshed.",
        );
      }
      const credential = decryptCredential(record, this.#key, vault.salt);
      if (credential.type !== "oauth2") {
        throw authMissing("The selected local vault credential is not OAuth2.");
      }
      if (!force && !isExpired(credential, this.#now())) {
        return resolvedCredential(
          credential,
          record.key.connectionId,
        ) as OAuth2Credential;
      }
      const endpoint = this.#oauth[record.key.toolkitSlug];
      if (credential.refreshToken === undefined || endpoint === undefined) {
        throw new CredentialProviderError({
          code: "auth_expired",
          message: `The stored ${record.key.toolkitSlug} OAuth credential is expired and cannot be refreshed. ${reconnectMessage(record.key)}`,
          retryable: false,
        });
      }

      let tokenSet: OAuthTokenSet;
      try {
        tokenSet = await requestOAuthToken({
          endpoint,
          clientId: credential.clientId,
          ...(credential.clientSecret === undefined
            ? {}
            : { clientSecret: credential.clientSecret }),
          parameters: {
            grant_type: "refresh_token",
            refresh_token: credential.refreshToken,
            ...(endpoint.refreshParameters ?? {}),
          },
          fetchImpl: this.#fetchImpl,
          now: this.#now,
        });
      } catch (error) {
        throw new CredentialProviderError({
          code: "auth_expired",
          message: `Refreshing the stored ${record.key.toolkitSlug} OAuth credential failed. ${reconnectMessage(record.key)}`,
          retryable: false,
          cause: error,
        });
      }

      const refreshed: LocalVaultOAuth2Credential = {
        ...credential,
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken ?? credential.refreshToken,
        ...(tokenSet.expiresAt === undefined
          ? {}
          : { expiresAt: tokenSet.expiresAt }),
        ...(tokenSet.scopes === undefined
          ? {}
          : { scopes: [...tokenSet.scopes] }),
        ...(tokenSet.tokenType === undefined
          ? {}
          : { tokenType: tokenSet.tokenType }),
      };
      if (tokenSet.expiresAt === undefined) {
        delete refreshed.expiresAt;
      }
      const now = this.#now().toISOString();
      const updatedBase = {
        id: record.id,
        key: record.key,
        revision: record.revision + 1,
        nonceSeed: randomBytes(NONCE_SEED_BYTES).toString("base64"),
      };
      const encrypted = encryptCredential(refreshed, {
        key: this.#key,
        salt: vault.salt,
        record: updatedBase,
      });
      vault.records[index] = {
        ...updatedBase,
        ...encrypted,
        createdAt: record.createdAt,
        updatedAt: now,
      };
      await writeVaultFile(this.filePath, vault);
      return resolvedCredential(
        refreshed,
        record.key.connectionId,
      ) as OAuth2Credential;
    });
  }
}
