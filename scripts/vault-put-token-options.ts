export type VaultCredentialType = "oauth2" | "api_key";

export interface VaultPutTokenOptions {
  readonly userId: string;
  readonly toolkitSlug: string;
  readonly credentialType: VaultCredentialType;
  readonly clientId?: string;
  readonly valueKey?: string;
}

const OPTION_NAMES = new Set([
  "--user",
  "--toolkit",
  "--type",
  "--client-id",
  "--value-key",
]);

export class VaultPutTokenCliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPutTokenCliInputError";
  }
}

function requiredOption(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new VaultPutTokenCliInputError(
      `Missing required non-secret option: ${name}.`,
    );
  }
  return value;
}

/**
 * Accepts only the documented non-secret selectors. Credential material has no
 * argv representation and must be supplied through EYEBALL_STORE_ACCESS_TOKEN.
 */
export function parseVaultPutTokenOptions(
  args: readonly string[],
): VaultPutTokenOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === undefined || !OPTION_NAMES.has(name)) {
      throw new VaultPutTokenCliInputError(
        "Only documented non-secret options are accepted; credential material must be supplied through EYEBALL_STORE_ACCESS_TOKEN.",
      );
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new VaultPutTokenCliInputError(
        `${name} requires a non-secret value.`,
      );
    }
    if (values.has(name)) {
      throw new VaultPutTokenCliInputError(
        `Duplicate non-secret option: ${name}.`,
      );
    }
    values.set(name, value);
  }

  const credentialType = values.get("--type") ?? "oauth2";
  if (credentialType !== "oauth2" && credentialType !== "api_key") {
    throw new VaultPutTokenCliInputError("--type must be oauth2 or api_key.");
  }

  const clientId = values.get("--client-id");
  const valueKey = values.get("--value-key");
  return {
    userId: requiredOption("--user", values.get("--user")),
    toolkitSlug: requiredOption("--toolkit", values.get("--toolkit")),
    credentialType,
    ...(clientId === undefined ? {} : { clientId }),
    ...(valueKey === undefined ? {} : { valueKey }),
  };
}

export function requiredVaultConfiguration(
  name: string,
  value: string | undefined,
): string {
  if (value === undefined || value.length === 0) {
    throw new VaultPutTokenCliInputError(
      `Missing required environment configuration: ${name}.`,
    );
  }
  return value;
}

/** Keeps provider/vault causes, which may contain secret-bearing data, off stderr. */
export function vaultPutTokenErrorMessage(error: unknown): string {
  return error instanceof VaultPutTokenCliInputError
    ? error.message
    : "Credential could not be stored. Check the vault path, project, key, and file permissions.";
}
