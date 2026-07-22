#!/usr/bin/env node

// Store a pre-obtained provider secret into the local encrypted vault. This is
// the connect path for providers that issue a single long-lived secret with no
// code-exchange flow. Two record shapes are supported via --type:
//
//   --type oauth2 (default): an accessToken-only oauth2 record, for providers
//     whose manifest auth.class is "oauth2" but which also accept a long-lived
//     bearer token — Notion internal integrations, GitHub PATs, Airtable PATs,
//     Linear PATs. Used verbatim as `Authorization: Bearer <token>`.
//
//   --type api_key: an api_key record { values: { <valueKey>: <secret> } }, for
//     providers whose manifest auth.class is "api_key" — Stripe secret keys,
//     SendGrid/Resend keys, Telegram bot tokens. The shared HTTP client's
//     apiKeyBearerValue prefers the `apiKey` field and emits the same
//     `Authorization: Bearer <secret>` header.
//
// The secret is always read from an environment variable (never argv) so it
// stays out of shell history and the process table. Neither record shape carries
// expiresAt/refreshToken, so the vault never attempts a refresh
// (LocalVaultCredentialProvider only refreshes an oauth2 record whose expiresAt
// is set and past).
//
// Required env: EYEBALL_PROJECT_ID, EYEBALL_VAULT_PATH, EYEBALL_VAULT_KEY,
//               EYEBALL_STORE_ACCESS_TOKEN
// Usage: node --import tsx scripts/eyeball-vault-put-token.ts \
//          --user <id> --toolkit <slug> \
//          [--type oauth2|api_key] [--client-id <label>] [--value-key <field>]

import {
  LocalVaultCredentialProvider,
  type ToolkitSlug,
} from "../packages/core/src/index.js";

function option(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required value: ${name}.`);
  }
  return value;
}

// Read named environment variables through a dynamic key. Biome's turbo-aware
// noUndeclaredEnvVars rule only inspects statically-known keys; these vars are
// CLI runtime inputs (a secret plus vault locators), not Turborepo build-cache
// dependencies that belong in turbo.json, so a dynamic lookup keeps them out of
// the build config while matching how eyeball-auth.ts passes process.env through.
const environment = process.env;
function envValue(name: string): string | undefined {
  return environment[name];
}

async function main(): Promise<void> {
  const userId = required("--user", option("user"));
  const toolkitSlug = required("--toolkit", option("toolkit")) as ToolkitSlug;
  const credentialType = option("type") ?? "oauth2";
  if (credentialType !== "oauth2" && credentialType !== "api_key") {
    throw new Error(
      `--type must be oauth2 or api_key (got ${credentialType}).`,
    );
  }

  const secret = required(
    "EYEBALL_STORE_ACCESS_TOKEN",
    envValue("EYEBALL_STORE_ACCESS_TOKEN"),
  );
  const filePath = required(
    "EYEBALL_VAULT_PATH",
    envValue("EYEBALL_VAULT_PATH"),
  );
  const allowedProjectId = required(
    "EYEBALL_PROJECT_ID",
    envValue("EYEBALL_PROJECT_ID"),
  );

  const provider = new LocalVaultCredentialProvider({
    filePath,
    allowedProjectId,
    env: environment,
  });

  if (credentialType === "oauth2") {
    // clientId is a required field on the stored record but is only consulted
    // for token refresh, which never runs for an accessToken-only credential. A
    // label documents provenance without being a real OAuth client id.
    const clientId = option("client-id") ?? "static-access-token";
    await provider.put({
      userId,
      toolkitSlug,
      credential: { type: "oauth2", accessToken: secret, clientId },
    });
  } else {
    // apiKeyBearerValue prefers the `apiKey` field, so default to it; a single
    // named value becomes `Authorization: Bearer <secret>`.
    const valueKey = option("value-key") ?? "apiKey";
    await provider.put({
      userId,
      toolkitSlug,
      credential: { type: "api_key", values: { [valueKey]: secret } },
    });
  }

  // Never print the secret. Confirm only the non-secret selector.
  process.stdout.write(
    `Stored ${toolkitSlug} ${credentialType} credential for user ${userId}.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
