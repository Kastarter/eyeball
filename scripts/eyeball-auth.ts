#!/usr/bin/env node

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { ExecutionEngine } from "../apps/executor/src/engine.js";
import {
  credentialMappingForManifest,
  defaultCatalog,
  type ResolvedToolkitOAuthConfig,
  resolvedOAuthTokenEndpoints,
  resolveToolkitOAuthConfig,
} from "../packages/catalog/src/index.js";
import {
  generateLocalVaultKey,
  initializeLocalVaultFile,
  isConnectionId,
  LocalVaultCredentialProvider,
  type LocalVaultRecordSelector,
  requestOAuthToken,
  type ToolkitSlug,
  validateInput,
} from "../packages/core/src/index.js";

const DEFAULT_VAULT_RELATIVE_PATH = ".eyeball/vault.json";
const DEFAULT_CALLBACK = "http://127.0.0.1:53682/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1_000;

interface ParsedArguments {
  positionals: readonly string[];
  options: ReadonlyMap<string, readonly string[]>;
}

export interface OAuthCaptureRequest {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
}

export interface AuthCliDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  write?: (value: string) => void;
  writeError?: (value: string) => void;
  prompt?: (question: string) => Promise<string>;
  captureRedirect?: (request: OAuthCaptureRequest) => Promise<string>;
  resolveOAuthConfig?: (
    toolkitSlug: ToolkitSlug,
    env: Readonly<Record<string, string | undefined>>,
  ) => ResolvedToolkitOAuthConfig | undefined;
}

interface RuntimeDependencies {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  fetchImpl: typeof fetch;
  now: () => Date;
  write: (value: string) => void;
  writeError: (value: string) => void;
  prompt: (question: string) => Promise<string>;
  captureRedirect?: (request: OAuthCaptureRequest) => Promise<string>;
  resolveOAuthConfig: (
    toolkitSlug: ToolkitSlug,
    env: Readonly<Record<string, string | undefined>>,
  ) => ResolvedToolkitOAuthConfig | undefined;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (name.length === 0) {
      throw new Error("An option name must follow --.");
    }
    const candidate = args[index + 1];
    const value =
      candidate !== undefined && !candidate.startsWith("--")
        ? candidate
        : "true";
    if (value !== "true" || candidate === "true") {
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positionals, options };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = option(parsed, name)?.trim();
  if (value === undefined || value.length === 0 || value === "true") {
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function hasFlag(parsed: ParsedArguments, name: string): boolean {
  return parsed.options.get(name)?.includes("true") === true;
}

function vaultPath(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): string {
  return resolve(
    dependencies.cwd,
    option(parsed, "vault") ??
      dependencies.env.EYEBALL_VAULT_PATH ??
      DEFAULT_VAULT_RELATIVE_PATH,
  );
}

function defaultPrompt(question: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  return terminal.question(question).finally(() => terminal.close());
}

function runtimeDependencies(
  dependencies: AuthCliDependencies,
): RuntimeDependencies {
  return {
    env: dependencies.env ?? process.env,
    cwd: dependencies.cwd ?? process.cwd(),
    fetchImpl: dependencies.fetchImpl ?? fetch,
    now: dependencies.now ?? (() => new Date()),
    write: dependencies.write ?? ((value) => stdout.write(value)),
    writeError:
      dependencies.writeError ?? ((value) => process.stderr.write(value)),
    prompt: dependencies.prompt ?? defaultPrompt,
    ...(dependencies.captureRedirect === undefined
      ? {}
      : { captureRedirect: dependencies.captureRedirect }),
    resolveOAuthConfig:
      dependencies.resolveOAuthConfig ?? resolveToolkitOAuthConfig,
  };
}

function localVaultProvider(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): LocalVaultCredentialProvider {
  return new LocalVaultCredentialProvider({
    filePath: vaultPath(parsed, dependencies),
    allowedProjectId:
      option(parsed, "project") ??
      dependencies.env.EYEBALL_PROJECT_ID ??
      "local",
    oauth: resolvedOAuthTokenEndpoints(dependencies.env),
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    env: dependencies.env,
  });
}

function toolkitManifest(toolkitSlug: string) {
  const manifest = defaultCatalog.getManifest(toolkitSlug);
  if (manifest === undefined) {
    throw new Error(`Unknown toolkit: ${toolkitSlug}.`);
  }
  return manifest;
}

function recordSelector(
  parsed: ParsedArguments,
  toolkitSlug: ToolkitSlug,
): LocalVaultRecordSelector {
  const connectionId = option(parsed, "connection");
  if (connectionId !== undefined && !isConnectionId(connectionId)) {
    throw new Error("--connection must use the conn_<value> format.");
  }
  return {
    userId: requiredOption(parsed, "user"),
    toolkitSlug,
    ...(connectionId === undefined ? {} : { connectionId }),
  };
}

function parseAssignments(
  values: readonly string[],
  optionName: string,
): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`--${optionName} values must use field=value.`);
    }
    assignments.set(value.slice(0, separator), value.slice(separator + 1));
  }
  return assignments;
}

async function collectApiKeyValues(
  parsed: ParsedArguments,
  fields: readonly string[],
  dependencies: RuntimeDependencies,
): Promise<Readonly<Record<string, string>>> {
  const secrets = parsed.options.get("secret") ?? [];
  const unqualified = secrets.filter((value) => !value.includes("="));
  const assignments = parseAssignments(
    secrets.filter((value) => value.includes("=")),
    "secret",
  );
  if (unqualified.length > 0) {
    if (
      fields.length !== 1 ||
      unqualified.length !== 1 ||
      fields[0] === undefined
    ) {
      throw new Error(
        "Unqualified --secret is accepted only for a single-field API credential; otherwise use --secret field=value.",
      );
    }
    assignments.set(fields[0], unqualified[0] ?? "");
  }
  const result: Record<string, string> = {};
  for (const field of fields) {
    const supplied = assignments.get(field);
    const value = supplied ?? (await dependencies.prompt(`${field}: `));
    if (value.length === 0) {
      throw new Error(`${field} must not be empty.`);
    }
    result[field] = value;
  }
  const unexpected = [...assignments.keys()].filter(
    (field) => !fields.includes(field),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unknown credential field(s): ${unexpected.join(", ")}.`);
  }
  return result;
}

async function collectBasicCredential(
  parsed: ParsedArguments,
  toolkitSlug: ToolkitSlug,
  dependencies: RuntimeDependencies,
) {
  const manifest = toolkitManifest(toolkitSlug);
  const mapping = credentialMappingForManifest(manifest);
  if (mapping.type !== "basic") {
    throw new Error(`${toolkitSlug} does not use Basic authentication.`);
  }
  const secretValues = parsed.options.get("secret") ?? [];
  if (secretValues.length > 1 || secretValues[0]?.includes("=")) {
    throw new Error(
      "Basic authentication accepts one unqualified --secret value.",
    );
  }
  const username =
    option(parsed, "username") ?? (await dependencies.prompt("Username: "));
  const password =
    secretValues[0] ?? (await dependencies.prompt("Password/API secret: "));
  if (username.length === 0 || password.length === 0) {
    throw new Error(
      "Basic username and password/API secret must not be empty.",
    );
  }
  const suppliedParameters = parseAssignments(
    parsed.options.get("parameter") ?? [],
    "parameter",
  );
  const parameterNames = Object.keys(mapping.parameterEnvs ?? {});
  const parameters: Record<string, string> = {};
  for (const name of parameterNames) {
    const value =
      suppliedParameters.get(name) ?? (await dependencies.prompt(`${name}: `));
    if (value.length === 0) {
      throw new Error(`${name} must not be empty.`);
    }
    parameters[name] = value;
  }
  const unexpected = [...suppliedParameters.keys()].filter(
    (name) => !parameterNames.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Unknown Basic parameter(s): ${unexpected.join(", ")}.`);
  }
  return {
    type: "basic" as const,
    username,
    password,
    ...(parameterNames.length === 0 ? {} : { parameters }),
  };
}

interface PreparedAuthorization {
  authorizeUrl: string;
  codeVerifier?: string;
}

function authorizationUrl(
  config: ResolvedToolkitOAuthConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): PreparedAuthorization {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  if (config.scopes.length > 0) {
    url.searchParams.set(
      "scope",
      config.scopes.join(config.scopeSeparator === "comma" ? "," : " "),
    );
  }
  url.searchParams.set("state", state);
  for (const [name, value] of Object.entries(config.authorizeParameters)) {
    url.searchParams.set(name, value);
  }
  if (config.pkce === "S256") {
    const codeVerifier = randomBytes(48).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizeUrl: url.toString(), codeVerifier };
  }
  return { authorizeUrl: url.toString() };
}

async function captureLocalRedirect(
  redirectUri: string,
  dependencies: RuntimeDependencies,
): Promise<string> {
  const callback = new URL(redirectUri);
  if (
    callback.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(callback.hostname)
  ) {
    throw new Error(
      "Local callback capture requires an http://localhost, 127.0.0.1, or ::1 redirect URI.",
    );
  }
  const port = callback.port.length === 0 ? 80 : Number(callback.port);
  return new Promise<string>((resolveRedirect, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      server.close(() => {
        if (error !== undefined) {
          reject(error);
        } else if (value !== undefined) {
          resolveRedirect(value);
        }
      });
    };
    const server = createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `${callback.protocol}//${callback.host}`,
      );
      if (requestUrl.pathname !== callback.pathname) {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Not found\n");
        return;
      }
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Eyeball authorization received. You may close this tab.\n");
      finish(undefined, requestUrl.toString());
    });
    const timeout = setTimeout(
      () => finish(new Error("Timed out waiting for the OAuth callback.")),
      CALLBACK_TIMEOUT_MS,
    );
    timeout.unref();
    server.once("error", (error) => finish(error));
    server.listen(port, callback.hostname, () => {
      dependencies.write(`Waiting for OAuth callback at ${redirectUri} ...\n`);
    });
  });
}

async function captureOAuthRedirect(
  parsed: ParsedArguments,
  request: OAuthCaptureRequest,
  dependencies: RuntimeDependencies,
): Promise<string> {
  const supplied = option(parsed, "redirect-url");
  if (supplied !== undefined && supplied !== "true") {
    return supplied;
  }
  if (dependencies.captureRedirect !== undefined) {
    return dependencies.captureRedirect(request);
  }
  if (hasFlag(parsed, "manual")) {
    return dependencies.prompt("Paste the complete redirect URL: ");
  }
  try {
    return await captureLocalRedirect(request.redirectUri, dependencies);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown bind error";
    dependencies.writeError(
      `Local callback capture is unavailable (${reason}). Switching to manual paste mode.\n`,
    );
    return dependencies.prompt("Paste the complete redirect URL: ");
  }
}

function validateShopifyCallback(
  redirect: URL,
  config: ResolvedToolkitOAuthConfig,
  clientSecret: string | undefined,
): void {
  if (clientSecret === undefined) {
    throw new Error(
      "Shopify OAuth callback validation requires a client secret.",
    );
  }
  const suppliedHmac = redirect.searchParams.get("hmac");
  if (suppliedHmac === null || !/^[a-f0-9]{64}$/u.test(suppliedHmac)) {
    throw new Error("Shopify OAuth callback has a missing or invalid HMAC.");
  }
  const shop = redirect.searchParams.get("shop");
  const expectedShop = new URL(config.authorizeUrl).hostname;
  if (
    shop === null ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/iu.test(shop) ||
    shop.toLowerCase() !== expectedShop.toLowerCase()
  ) {
    throw new Error(
      "Shopify OAuth callback shop does not match the configured shop.",
    );
  }
  const message = [...redirect.searchParams.entries()]
    .filter(([name]) => name !== "hmac")
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
      }
      return leftValue < rightValue ? -1 : leftValue === rightValue ? 0 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const expectedHmac = createHmac("sha256", clientSecret)
    .update(message)
    .digest();
  const actualHmac = Buffer.from(suppliedHmac, "hex");
  if (
    actualHmac.length !== expectedHmac.length ||
    !timingSafeEqual(actualHmac, expectedHmac)
  ) {
    throw new Error("Shopify OAuth callback HMAC verification failed.");
  }
}

function parseAuthorizationResponse(
  value: string,
  expectedState: string,
  config: ResolvedToolkitOAuthConfig,
  clientSecret: string | undefined,
): string {
  let redirect: URL;
  try {
    redirect = new URL(value.trim());
  } catch (error) {
    throw new Error("The pasted OAuth redirect URL is invalid.", {
      cause: error,
    });
  }
  const providerError = redirect.searchParams.get("error");
  if (providerError !== null) {
    throw new Error(`OAuth authorization failed (${providerError}).`);
  }
  if (redirect.searchParams.get("state") !== expectedState) {
    throw new Error("OAuth state mismatch; authorization was not stored.");
  }
  if (config.callbackValidation === "shopify-hmac-sha256") {
    validateShopifyCallback(redirect, config, clientSecret);
  }
  const code = redirect.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new Error("The OAuth redirect URL does not contain a code.");
  }
  return code;
}

async function addOAuthCredential(
  parsed: ParsedArguments,
  selector: LocalVaultRecordSelector,
  provider: LocalVaultCredentialProvider,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const config = dependencies.resolveOAuthConfig(
    selector.toolkitSlug,
    dependencies.env,
  );
  if (config === undefined) {
    throw new Error(
      `${selector.toolkitSlug} has no OAuth metadata; add a grounded configuration before connecting it.`,
    );
  }
  if (config.endpointVerification === "todo-verify") {
    dependencies.writeError(
      `Warning: ${selector.toolkitSlug} OAuth metadata is TODO-verify. ${config.verificationNote}\n`,
    );
  }
  const clientId =
    option(parsed, "client-id") ?? dependencies.env[config.clientIdEnv];
  if (clientId === undefined || clientId.trim().length === 0) {
    throw new Error(
      `OAuth client ID is required via --client-id or ${config.clientIdEnv}.`,
    );
  }
  const clientSecret =
    option(parsed, "client-secret") ??
    dependencies.env[config.clientSecretEnv] ??
    (hasFlag(parsed, "public-client")
      ? undefined
      : await dependencies.prompt("OAuth client secret: "));
  if (clientSecret !== undefined && clientSecret.length === 0) {
    throw new Error("OAuth client secret must not be empty.");
  }
  const redirectUri = option(parsed, "redirect-uri") ?? DEFAULT_CALLBACK;
  const state = randomBytes(24).toString("base64url");
  const authorization = authorizationUrl(config, clientId, redirectUri, state);
  dependencies.write(
    `Open this URL to authorize ${selector.toolkitSlug}:\n${authorization.authorizeUrl}\n`,
  );
  dependencies.write(
    "If loopback capture is unavailable, the CLI switches to paste mode; use --manual to choose it immediately.\n",
  );
  const redirect = await captureOAuthRedirect(
    parsed,
    { authorizeUrl: authorization.authorizeUrl, redirectUri, state },
    dependencies,
  );
  const code = parseAuthorizationResponse(
    redirect,
    state,
    config,
    clientSecret,
  );
  const parameters: Record<string, string> = {
    ...config.authorizationCodeParameters,
    code,
  };
  if (config.authorizationCodeIncludesGrantType) {
    parameters.grant_type = "authorization_code";
  }
  if (config.authorizationCodeIncludesRedirectUri) {
    parameters.redirect_uri = redirectUri;
  }
  if (authorization.codeVerifier !== undefined) {
    parameters.code_verifier = authorization.codeVerifier;
  }
  const tokenSet = await requestOAuthToken({
    endpoint: config.tokenEndpoint,
    clientId,
    ...(clientSecret === undefined ? {} : { clientSecret }),
    parameters,
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
  });
  await provider.put({
    ...selector,
    credential: {
      type: "oauth2",
      accessToken: tokenSet.accessToken,
      clientId,
      redirectUri,
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(tokenSet.refreshToken === undefined
        ? {}
        : { refreshToken: tokenSet.refreshToken }),
      ...(tokenSet.expiresAt === undefined
        ? {}
        : { expiresAt: tokenSet.expiresAt }),
      ...(tokenSet.scopes === undefined ? {} : { scopes: tokenSet.scopes }),
      ...(tokenSet.tokenType === undefined
        ? {}
        : { tokenType: tokenSet.tokenType }),
    },
  });
}

async function commandInit(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const filePath = await initializeLocalVaultFile(
    vaultPath(parsed, dependencies),
  );
  const key = generateLocalVaultKey();
  dependencies.write(`Initialized empty local vault at ${filePath}.\n`);
  dependencies.write(
    "Store this key in your secret manager; it is not recoverable from the vault:\n",
  );
  dependencies.write(`export EYEBALL_VAULT_KEY='${key}'\n`);
  dependencies.write(`export EYEBALL_VAULT_PATH='${filePath}'\n`);
}

async function commandAdd(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const toolkitSlug = parsed.positionals[1];
  if (toolkitSlug === undefined) {
    throw new Error("Usage: eyeball-auth add <toolkit> --user <id>.");
  }
  const manifest = toolkitManifest(toolkitSlug);
  const selector = recordSelector(parsed, toolkitSlug);
  const provider = localVaultProvider(parsed, dependencies);
  switch (manifest.auth.class) {
    case "oauth2":
      await addOAuthCredential(parsed, selector, provider, dependencies);
      break;
    case "api_key":
      await provider.put({
        ...selector,
        credential: {
          type: "api_key",
          values: await collectApiKeyValues(
            parsed,
            manifest.auth.fields ?? ["apiKey"],
            dependencies,
          ),
        },
      });
      break;
    case "basic":
      await provider.put({
        ...selector,
        credential: await collectBasicCredential(
          parsed,
          toolkitSlug,
          dependencies,
        ),
      });
      break;
    case "none":
      await provider.put({ ...selector, credential: { type: "none" } });
      break;
  }
  dependencies.write(
    `Stored ${manifest.auth.class} credential for ${selector.userId}/${selector.toolkitSlug}${selector.connectionId === undefined ? "" : `/${selector.connectionId}`} in ${provider.filePath}.\n`,
  );
}

async function commandList(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const provider = localVaultProvider(parsed, dependencies);
  const userId = option(parsed, "user");
  const records = await provider.list({
    ...(userId === undefined ? {} : { userId }),
  });
  if (hasFlag(parsed, "json")) {
    dependencies.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  if (records.length === 0) {
    dependencies.write("No local vault credentials found.\n");
    return;
  }
  for (const record of records) {
    const connection = record.connectionId ?? "default";
    const expiry =
      record.expiresAt === undefined ? "" : ` expires=${record.expiresAt}`;
    dependencies.write(
      `${record.userId}\t${record.toolkitSlug}\t${connection}\t${record.type}${expiry}\n`,
    );
  }
}

async function commandRemove(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const toolkitSlug = parsed.positionals[1];
  if (toolkitSlug === undefined) {
    throw new Error("Usage: eyeball-auth remove <toolkit> --user <id>.");
  }
  toolkitManifest(toolkitSlug);
  const provider = localVaultProvider(parsed, dependencies);
  const selector = recordSelector(parsed, toolkitSlug);
  const removed = await provider.remove(selector);
  if (!removed) {
    throw new Error("No matching local vault credential was found.");
  }
  dependencies.write(`Removed ${selector.userId}/${selector.toolkitSlug}.\n`);
}

function parseJsonInput(parsed: ParsedArguments): unknown {
  const value = option(parsed, "input");
  if (value === undefined) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error("--input must be valid JSON.", { cause: error });
  }
}

async function commandTest(
  parsed: ParsedArguments,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const toolkitSlug = parsed.positionals[1];
  if (toolkitSlug === undefined) {
    throw new Error(
      "Usage: eyeball-auth test <toolkit> --user <id> [--input JSON].",
    );
  }
  toolkitManifest(toolkitSlug);
  const input = parseJsonInput(parsed);
  const requestedTool = option(parsed, "tool");
  const tools = defaultCatalog
    .listTools({ toolkit: toolkitSlug })
    .filter(
      (tool) =>
        tool.annotations.readOnly &&
        !tool.annotations.async &&
        (requestedTool === undefined || tool.name === requestedTool),
    );
  const tool = tools.find((candidate) => validateInput(candidate, input).ok);
  if (tool === undefined) {
    throw new Error(
      requestedTool === undefined
        ? `No synchronous read-only ${toolkitSlug} tool accepts this input. Pass --tool and --input with a safe canonical probe.`
        : `${requestedTool} is not a synchronous read-only tool or the supplied input is invalid.`,
    );
  }
  const projectId =
    option(parsed, "project") ?? dependencies.env.EYEBALL_PROJECT_ID ?? "local";
  const engine = new ExecutionEngine({
    credentialProvider: localVaultProvider(parsed, dependencies),
    fetchImpl: dependencies.fetchImpl,
    env: dependencies.env,
  });
  const outcome = await engine.execute({
    projectId,
    request: {
      tool: tool.name,
      userId: requiredOption(parsed, "user"),
      ...(option(parsed, "connection") === undefined
        ? {}
        : { connectionId: option(parsed, "connection") }),
      input,
      mode: "sync",
    },
  });
  dependencies.write(`${JSON.stringify(outcome.response, null, 2)}\n`);
  if (outcome.response.status !== "succeeded") {
    throw new Error(`${tool.name} credential test did not succeed.`);
  }
}

function usage(): string {
  return [
    "eyeball-auth — manage the encrypted OSS credential vault",
    "",
    "Commands:",
    "  init [--vault path]",
    "  add <toolkit> --user <id> [--connection <id>] [auth options]",
    "  list [--user <id>] [--json]",
    "  remove <toolkit> --user <id> [--connection <id>]",
    "  test <toolkit> --user <id> [--tool <qualified-name>] [--input <json>]",
    "",
    "OAuth options: --client-id, --client-secret, --public-client, --redirect-uri, --manual, --redirect-url",
    "Static auth options: --secret [field=value], --username, --parameter field=value",
    "Common options: --vault path, --project id, --connection conn_<value>",
  ].join("\n");
}

export async function runAuthCli(
  args: readonly string[],
  dependencies: AuthCliDependencies = {},
): Promise<void> {
  const runtime = runtimeDependencies(dependencies);
  const parsed = parseArguments(args);
  const command = parsed.positionals[0];
  switch (command) {
    case "init":
      await commandInit(parsed, runtime);
      return;
    case "add":
      await commandAdd(parsed, runtime);
      return;
    case "list":
      await commandList(parsed, runtime);
      return;
    case "remove":
      await commandRemove(parsed, runtime);
      return;
    case "test":
      await commandTest(parsed, runtime);
      return;
    case "help":
    case "--help":
    case undefined:
      runtime.write(`${usage()}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  runAuthCli(process.argv.slice(2)).catch((error: unknown) => {
    // Walk the cause chain so a wrapped typed error (e.g. the executor's
    // "Credential provider failed unexpectedly." wrapping a
    // CredentialProviderError code=auth_missing) still reveals its real,
    // actionable message instead of only the opaque outer one.
    const lines: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
      seen.add(current);
      if (current instanceof Error) {
        const code = (current as { code?: unknown }).code;
        lines.push(
          typeof code === "string" && code.length > 0
            ? `${current.message} (code: ${code})`
            : current.message,
        );
        current = (current as { cause?: unknown }).cause;
      } else {
        lines.push(String(current));
        current = undefined;
      }
    }
    process.stderr.write(`eyeball-auth: ${lines.join("\n  cause: ")}\n`);
    process.exitCode = 1;
  });
}
