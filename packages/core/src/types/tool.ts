export const JSON_SCHEMA_DRAFT_2020_12 =
  "https://json-schema.org/draft/2020-12/schema" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JSONSchema202012 = boolean | JSONSchemaObject202012;

export interface JSONSchemaObject202012 {
  $schema?: typeof JSON_SCHEMA_DRAFT_2020_12 | string;
  $id?: string;
  $ref?: string;
  $defs?: Readonly<Record<string, JSONSchema202012>>;
  title?: string;
  description?: string;
  type?:
    | "null"
    | "boolean"
    | "object"
    | "array"
    | "number"
    | "integer"
    | "string"
    | readonly (
        | "null"
        | "boolean"
        | "object"
        | "array"
        | "number"
        | "integer"
        | "string"
      )[];
  properties?: Readonly<Record<string, JSONSchema202012>>;
  required?: readonly string[];
  additionalProperties?: JSONSchema202012;
  items?: JSONSchema202012;
  enum?: readonly JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  examples?: readonly JsonValue[];
  anyOf?: readonly JSONSchema202012[];
  oneOf?: readonly JSONSchema202012[];
  allOf?: readonly JSONSchema202012[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  [keyword: string]: unknown;
}

export interface ObjectSchema202012 extends JSONSchemaObject202012 {
  type: "object";
}

export type ToolkitSlug = string;
export type CanonicalToolName = string;
export type QualifiedToolName = `${string}.${string}`;
export type CanonicalTriggerName = string;
export type QualifiedTriggerName = `${string}.${string}`;
export type SemVer = `${number}.${number}.${number}`;
export type CatalogVersion = `${number}.${number}`;

export const CAPABILITY_SLUGS = [
  "email",
  "calendar_scheduling",
  "messaging_chat",
  "voice_telephony",
  "sms",
  "crm",
  "erp_accounting",
  "social_media_data",
  "social_media_publishing",
  "file_storage_docs",
  "spreadsheets_databases",
  "project_management_dev_tools",
  "payments_billing",
  "ecommerce",
  "customer_support",
  "web_search_scraping",
  "hr_recruiting",
  "marketing_ads",
  "sign_forms",
  "ai_media_utilities",
] as const;

export type CapabilitySlug = (typeof CAPABILITY_SLUGS)[number];

export interface ToolAnnotations {
  /** True only when the tool cannot change external state. */
  readOnly: boolean;
  /** True when the tool may delete, overwrite, debit, revoke, or otherwise cause loss. */
  destructive: boolean;
  /** True when repeating the provider operation has no additional effect. */
  idempotent: boolean;
  /** True when the operation is async by nature and rejects sync mode. */
  async: boolean;
}

export interface ToolDefinition {
  /** Exactly `<toolkit>.<canonical-tool>`, for example `gmail.send_email`. */
  name: QualifiedToolName;
  toolkit: ToolkitSlug;
  capability: CapabilitySlug;
  /** LLM-facing purpose, selection guidance, exclusions, and consequences. */
  description: string;
  inputSchema: ObjectSchema202012;
  outputSchema?: ObjectSchema202012;
  annotations: ToolAnnotations;
  version: SemVer;
}

export interface CapabilityToolContract {
  capability: CapabilitySlug;
  name: CanonicalToolName;
  description: string;
  inputSchema: ObjectSchema202012;
  outputSchema?: ObjectSchema202012;
  annotations: ToolAnnotations;
  version: SemVer;
}

/** Provider-neutral event contract shared by every implementation of a trigger. */
export interface CapabilityTriggerContract {
  capability: CapabilitySlug;
  name: CanonicalTriggerName;
  description: string;
  /** Canonical payload delivered in `trigger.<toolkit>.<canonical-trigger>`. */
  payloadSchema: ObjectSchema202012;
  annotations: CapabilityTriggerAnnotations;
  version: SemVer;
}

export interface CapabilityTriggerAnnotations {
  /** Provider identities are claimed within the configured idempotency window. */
  deduplicated: boolean;
  /** Whether the runtime exposes a public replay or backfill operation. */
  replayable: boolean;
}

export const AUTH_CLASSES = ["oauth2", "api_key", "basic", "none"] as const;
export type AuthClass = (typeof AUTH_CLASSES)[number];

export const PROVIDER_SOURCES = [
  "activepieces-bridge",
  "native",
  "scrapecreators",
] as const;
export type ProviderSource = (typeof PROVIDER_SOURCES)[number];

export const DELIVERY_TIERS = ["P0", "P1", "P2"] as const;
export type DeliveryTier = (typeof DELIVERY_TIERS)[number];

export interface ProviderAuthRequirement {
  class: AuthClass;
  requiredScopes?: readonly string[];
  optionalScopes?: readonly string[];
  /** Logical credential keys, such as `apiKey` or `accountSid`. */
  fields?: readonly string[];
}

export interface ProviderToolImplementation {
  capability: CapabilitySlug;
  canonicalTool: CanonicalToolName;
  canonicalVersion: SemVer;
  operationId: string;
  requiredScopes?: readonly string[];
  /** Schema for `input.x_provider[manifest.toolkit.slug]` only. */
  inputExtensionSchema?: ObjectSchema202012;
  /** Schema for `output.x_provider[manifest.toolkit.slug]` only. */
  outputExtensionSchema?: ObjectSchema202012;
}

export type ProviderTriggerDelivery =
  | {
      mode: "polling";
      /** Provider-safe cadence used by the hosted scheduler. */
      defaultIntervalSeconds: number;
      minimumIntervalSeconds: number;
    }
  | {
      mode: "push";
      /** Provider event name routed to this canonical trigger. */
      providerEvent: string;
    };

export interface ProviderTriggerImplementation {
  capability: CapabilitySlug;
  canonicalTrigger: CanonicalTriggerName;
  canonicalVersion: SemVer;
  operationId: string;
  delivery: ProviderTriggerDelivery;
  requiredScopes?: readonly string[];
  /** Schema for `payload.x_provider[manifest.toolkit.slug]` only. */
  payloadExtensionSchema?: ObjectSchema202012;
}

export type TriggerAnnotations = CapabilityTriggerAnnotations &
  (
    | {
        deliveryMode: "polling";
        defaultIntervalSeconds: number;
        minimumIntervalSeconds: number;
      }
    | {
        deliveryMode: "push";
        providerEvent: string;
      }
  );

export interface TriggerDefinition {
  /** Exactly `<toolkit>.<canonical-trigger>`. */
  name: QualifiedTriggerName;
  toolkit: ToolkitSlug;
  capability: CapabilitySlug;
  description: string;
  payloadSchema: ObjectSchema202012;
  annotations: TriggerAnnotations;
  version: SemVer;
}

export interface Toolkit {
  slug: ToolkitSlug;
  displayName: string;
  source: ProviderSource;
  tier: DeliveryTier;
}

export interface ProviderManifest {
  schemaVersion: "1.0";
  catalogVersion: CatalogVersion;
  toolkit: Toolkit;
  auth: ProviderAuthRequirement;
  endpoint: {
    baseUrl: string;
    /** Trusted executor env var used by eyeball-mocks; never tool input. */
    baseUrlOverrideEnv?: string;
  };
  implements: readonly ProviderToolImplementation[];
  /** Additive reaction surface. Absence means the provider publishes no triggers. */
  triggers?: readonly ProviderTriggerImplementation[];
}

export interface CatalogManifest {
  catalogVersion: CatalogVersion;
  generatedAt: string;
  tools: readonly ToolDefinition[];
  triggers: readonly TriggerDefinition[];
  providers: readonly ProviderManifest[];
}
