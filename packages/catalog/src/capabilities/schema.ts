import {
  type CapabilitySlug,
  type CapabilityToolContract,
  type CapabilityTriggerContract,
  JSON_SCHEMA_DRAFT_2020_12,
  type JSONSchema202012,
  type ObjectSchema202012,
  type SemVer,
} from "@eyeball/core";

type SchemaProperties = Readonly<Record<string, JSONSchema202012>>;

interface PublishedSchemaOptions {
  capability: CapabilitySlug;
  tool: string;
  version?: SemVer;
  direction: "input" | "output";
  description: string;
  properties: SchemaProperties;
  required?: readonly string[];
}

interface PublishedTriggerSchemaOptions {
  capability: CapabilitySlug;
  trigger: string;
  version?: SemVer;
  description: string;
  properties: SchemaProperties;
  required?: readonly string[];
}

export function publishedObjectSchema({
  capability,
  tool,
  version = "1.0.0",
  direction,
  description,
  properties,
  required = [],
}: PublishedSchemaOptions): ObjectSchema202012 {
  const outputSegment = direction === "output" ? ":output" : "";
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: `urn:eyeball:${capability}:${tool}${outputSegment}:${version}`,
    type: "object",
    description,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

export function defineContract<const T extends CapabilityToolContract>(
  contract: T,
): T {
  return contract;
}

export function publishedTriggerSchema({
  capability,
  trigger,
  version = "1.0.0",
  description,
  properties,
  required = [],
}: PublishedTriggerSchemaOptions): ObjectSchema202012 {
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: `urn:eyeball:${capability}:${trigger}:payload:${version}`,
    type: "object",
    description,
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

export function defineTriggerContract<
  const T extends CapabilityTriggerContract,
>(contract: T): T {
  return contract;
}

export function pageSizeProperty(resource: string): JSONSchema202012 {
  return {
    type: "integer",
    description: `Maximum number of ${resource} to return in one page.`,
    minimum: 1,
    maximum: 100,
    default: 50,
  };
}

export function pageTokenProperty(resource: string): JSONSchema202012 {
  return {
    type: "string",
    description: `Opaque continuation token from a previous ${resource} page.`,
    minLength: 1,
  };
}

export function nextPageTokenProperty(resource: string): JSONSchema202012 {
  return {
    type: "string",
    description: `Opaque token to request the next page of ${resource}; absent when the result is complete.`,
    minLength: 1,
  };
}
