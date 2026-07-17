import type {
  EnvCredentialMapping,
  ProviderManifest,
  ToolkitSlug,
} from "@eyeball/core";
import { defaultCatalog } from "./default.js";

export function credentialEnvironmentPrefix(toolkitSlug: ToolkitSlug): string {
  return `EYEBALL_CRED_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_`;
}

function environmentFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replaceAll("-", "_")
    .toUpperCase();
}

export function credentialMappingForManifest(
  manifest: ProviderManifest,
): EnvCredentialMapping {
  const prefix = credentialEnvironmentPrefix(manifest.toolkit.slug);
  switch (manifest.auth.class) {
    case "oauth2":
      return {
        type: "oauth2",
        accessTokenEnv: `${prefix}ACCESS_TOKEN`,
        expiresAtEnv: `${prefix}EXPIRES_AT`,
        scopesEnv: `${prefix}SCOPES`,
      };
    case "api_key":
      return {
        type: "api_key",
        valueEnvs: Object.fromEntries(
          (manifest.auth.fields ?? ["apiKey"]).map((field) => [
            field,
            `${prefix}${environmentFieldName(field)}`,
          ]),
        ),
      };
    case "basic":
      if (manifest.toolkit.slug === "twilio") {
        return {
          type: "basic",
          usernameEnv: `${prefix}ACCOUNT_SID`,
          passwordEnv: `${prefix}AUTH_TOKEN`,
        };
      }
      if (manifest.toolkit.slug === "odoo") {
        return {
          type: "basic",
          usernameEnv: `${prefix}USERNAME`,
          passwordEnv: `${prefix}API_KEY`,
          parameterEnvs: { database: `${prefix}DATABASE` },
        };
      }
      return {
        type: "basic",
        usernameEnv: `${prefix}USERNAME`,
        passwordEnv: `${prefix}PASSWORD`,
      };
    case "none":
      return { type: "none" };
  }
}

export function defaultCredentialEnvironmentMappings(): Readonly<
  Record<ToolkitSlug, EnvCredentialMapping>
> {
  return Object.fromEntries(
    defaultCatalog
      .listManifests()
      .map((manifest) => [
        manifest.toolkit.slug,
        credentialMappingForManifest(manifest),
      ]),
  );
}

export function requiredCredentialEnvironment(
  mapping: EnvCredentialMapping,
): readonly string[] {
  switch (mapping.type) {
    case "oauth2":
      return [mapping.accessTokenEnv];
    case "api_key":
      return Object.values(mapping.valueEnvs);
    case "basic":
      return [
        mapping.usernameEnv,
        mapping.passwordEnv,
        ...Object.values(mapping.parameterEnvs ?? {}),
      ];
    case "none":
      return [];
  }
}
