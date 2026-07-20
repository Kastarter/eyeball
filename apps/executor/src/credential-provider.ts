import {
  defaultCredentialEnvironmentMappings,
  resolvedOAuthTokenEndpoints,
} from "@eyeball/catalog";
import {
  type CredentialProvider,
  EnvCredentialProvider,
  LocalVaultCredentialProvider,
  MockCredentialProvider,
} from "@eyeball/core";
import { RemoteCredentialProvider } from "./remote-credential-provider.js";

export type CredentialProviderMode = "mock" | "env" | "local-vault" | "cloud";

export interface ConfiguredCredentialProviderOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  mode: CredentialProviderMode,
): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when EYEBALL_CREDENTIALS=${mode}.`);
  }
  return value;
}

export function credentialProviderMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialProviderMode {
  const value = env.EYEBALL_CREDENTIALS?.trim() ?? "mock";
  if (
    value !== "mock" &&
    value !== "env" &&
    value !== "local-vault" &&
    value !== "cloud"
  ) {
    throw new Error(
      "EYEBALL_CREDENTIALS must be mock, env, local-vault, or cloud.",
    );
  }
  return value;
}

export function createConfiguredCredentialProvider(
  options: ConfiguredCredentialProviderOptions = {},
): CredentialProvider {
  const env = options.env ?? process.env;
  const mode = credentialProviderMode(env);
  switch (mode) {
    case "mock":
      return new MockCredentialProvider([]);
    case "env":
      return new EnvCredentialProvider({
        mappings: defaultCredentialEnvironmentMappings(),
        env,
        allowedProjectId: requiredEnvironment(env, "EYEBALL_PROJECT_ID", mode),
        allowedUserId: requiredEnvironment(env, "EYEBALL_USER_ID", mode),
      });
    case "local-vault":
      return new LocalVaultCredentialProvider({
        filePath: requiredEnvironment(env, "EYEBALL_VAULT_PATH", mode),
        allowedProjectId: requiredEnvironment(env, "EYEBALL_PROJECT_ID", mode),
        oauth: resolvedOAuthTokenEndpoints(env),
        env,
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    case "cloud":
      return new RemoteCredentialProvider({
        endpoint: requiredEnvironment(env, "EYEBALL_CREDENTIALS_URL", mode),
        internalApiSecret: requiredEnvironment(
          env,
          "EYEBALL_INTERNAL_API_SECRET",
          mode,
        ),
        ...(options.fetchImpl === undefined
          ? {}
          : { fetchImpl: options.fetchImpl }),
      });
  }
}
