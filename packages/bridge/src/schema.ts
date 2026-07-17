import type {
  CapabilitySlug,
  JSONSchema202012,
  JSONSchemaObject202012,
  JsonValue,
  ObjectSchema202012,
  QualifiedToolName,
  SemVer,
  ToolAnnotations,
  ToolDefinition,
} from "@eyeball/core";
import { JSON_SCHEMA_DRAFT_2020_12, toRestrictedToolName } from "@eyeball/core";
import { resolvedCredentialToPieceAuth } from "./auth.js";
import { createRoutedFetch, runInsidePieceBoundary } from "./transport.js";
import type {
  ActivepiecesAction,
  ActivepiecesProperty,
  ActivepiecesPropertyContext,
  ActivepiecesStaticOptions,
  DynamicPropertyResolutionOptions,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedPropertyContextApi(name: string): never {
  throw new Error(
    `Activepieces ${name} is not supported by the experimental bridge.`,
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function staticOptions(
  property: ActivepiecesProperty,
): ActivepiecesStaticOptions | undefined {
  return isRecord(property.options) && Array.isArray(property.options.options)
    ? (property.options as unknown as ActivepiecesStaticOptions)
    : undefined;
}

function schemaMetadata(
  property: ActivepiecesProperty,
): Pick<JSONSchemaObject202012, "default" | "description" | "title"> {
  return {
    title: property.displayName,
    ...(property.description === undefined
      ? {}
      : { description: property.description }),
    ...(isJsonValue(property.defaultValue)
      ? { default: property.defaultValue }
      : {}),
  };
}

function staticEnum(
  property: ActivepiecesProperty,
): readonly JsonValue[] | undefined {
  const values = staticOptions(property)?.options.map((option) => option.value);
  return values === undefined ||
    values.length === 0 ||
    !values.every(isJsonValue)
    ? undefined
    : values;
}

function dynamicDescription(property: ActivepiecesProperty): string {
  const base = property.description ?? property.displayName;
  const refreshers = property.refreshers ?? [];
  return `${base} Activepieces resolves this property for the selected connection${
    refreshers.length === 0
      ? "."
      : ` after these inputs are known: ${refreshers.join(", ")}.`
  }`;
}

function nestedObjectSchema(
  props: Readonly<Record<string, ActivepiecesProperty>>,
): ObjectSchema202012 {
  const transformed = propsToJsonSchemaFromMap(props);
  return { ...transformed, additionalProperties: false };
}

/** Maps one Activepieces property to a Draft 2020-12 JSON Schema fragment. */
export function propertyToJsonSchema(
  property: ActivepiecesProperty,
): JSONSchemaObject202012 {
  const metadata = schemaMetadata(property);

  switch (property.type) {
    case "SHORT_TEXT":
    case "LONG_TEXT":
    case "MARKDOWN":
    case "SECRET_TEXT":
    case "COLOR":
      return { ...metadata, type: "string" };
    case "NUMBER":
      return { ...metadata, type: "number" };
    case "CHECKBOX":
      return { ...metadata, type: "boolean" };
    case "DATE_TIME":
      return { ...metadata, type: "string", format: "date-time" };
    case "STATIC_DROPDOWN": {
      const values = staticEnum(property);
      return {
        ...metadata,
        ...(values === undefined ? {} : { enum: values }),
      };
    }
    case "STATIC_MULTI_SELECT_DROPDOWN": {
      const values = staticEnum(property);
      return {
        ...metadata,
        type: "array",
        items: values === undefined ? {} : { enum: values },
      };
    }
    case "DROPDOWN":
      return {
        ...metadata,
        description: dynamicDescription(property),
      };
    case "MULTI_SELECT_DROPDOWN":
      return {
        ...metadata,
        type: "array",
        items: {},
        description: dynamicDescription(property),
      };
    case "DYNAMIC":
      return {
        ...metadata,
        type: "object",
        additionalProperties: true,
        description: dynamicDescription(property),
      };
    case "ARRAY":
      return {
        ...metadata,
        type: "array",
        items:
          property.properties === undefined
            ? {}
            : nestedObjectSchema(property.properties),
      };
    case "OBJECT":
    case "JSON":
      return { ...metadata, type: "object", additionalProperties: true };
    case "FILE":
      return {
        ...metadata,
        type: "object",
        properties: {
          filename: { type: "string" },
          base64: { type: "string", contentEncoding: "base64" },
          extension: { type: "string" },
        },
        required: ["filename", "base64"],
        additionalProperties: false,
      };
    case "BASIC_AUTH":
      return {
        ...metadata,
        type: "object",
        properties: {
          username: { type: "string" },
          password: { type: "string" },
        },
        required: ["username", "password"],
        additionalProperties: false,
      };
    case "CUSTOM_AUTH":
    case "OAUTH2":
    case "OIDC":
      return { ...metadata, type: "object", additionalProperties: true };
    case "CUSTOM":
      return metadata;
    default:
      return metadata;
  }
}

function propsToJsonSchemaFromMap(
  props: Readonly<Record<string, ActivepiecesProperty>>,
): ObjectSchema202012 {
  const visibleProps = Object.entries(props).filter(
    ([, property]) => property.type !== "MARKDOWN",
  );
  const properties: Record<string, JSONSchema202012> = {};
  const required: string[] = [];

  for (const [name, property] of visibleProps) {
    properties[name] = propertyToJsonSchema(property);
    if (property.required) {
      required.push(name);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

/** Transforms an action's declared props into an experimental input schema. */
export function propsToJsonSchema(
  action: Pick<ActivepiecesAction, "props">,
): ObjectSchema202012 {
  return propsToJsonSchemaFromMap(action.props);
}

export interface ActionToToolDefinitionOptions {
  readonly toolkit: string;
  readonly capability: CapabilitySlug;
  readonly annotations: ToolAnnotations;
  readonly version?: SemVer;
  readonly canonicalName?: string;
}

export function canonicalizeActionName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  if (normalized.length === 0) {
    throw new Error(`Cannot canonicalize Activepieces action name: ${name}`);
  }
  return normalized;
}

/** Builds the RFC 001 tool-definition shell; semantics remain a curated overlay. */
export function actionToToolDefinition(
  action: ActivepiecesAction,
  options: ActionToToolDefinitionOptions,
): ToolDefinition {
  const canonicalName =
    options.canonicalName ?? canonicalizeActionName(action.name);
  const name = `${options.toolkit}.${canonicalName}` as QualifiedToolName;
  toRestrictedToolName(name);
  return {
    name,
    toolkit: options.toolkit,
    capability: options.capability,
    description: action.description || action.displayName,
    inputSchema: {
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      ...propsToJsonSchema(action),
    },
    annotations: options.annotations,
    version: options.version ?? "0.1.0",
  };
}

function propertyContext(
  options: DynamicPropertyResolutionOptions,
): ActivepiecesPropertyContext {
  return {
    server: {
      apiUrl: "http://eyeball.local",
      publicUrl: "http://eyeball.local",
      token: "bridge-property-context",
    },
    project: {
      id: options.projectId ?? "bridge-project",
      externalId: async () => undefined,
    },
    ...(options.searchValue === undefined
      ? {}
      : { searchValue: options.searchValue }),
    flows: {
      current: { id: "bridge-flow", version: { id: "bridge-version" } },
      list: async () => unsupportedPropertyContextApi("flows.list"),
    },
    connections: {
      get: async () => unsupportedPropertyContextApi("connections.get"),
    },
  };
}

/**
 * Resolves a real DYNAMIC property with a selected credential, then transforms
 * the returned field map. This is connection-time schema hydration, not a
 * static catalog-build step.
 */
export async function resolveDynamicPropertySchema(
  options: DynamicPropertyResolutionOptions,
): Promise<ObjectSchema202012> {
  const action = options.piece.getAction(options.actionName);
  if (action === undefined) {
    throw new Error(`Activepieces action not found: ${options.actionName}`);
  }
  const property = action.props[options.propertyName];
  if (property === undefined) {
    throw new Error(
      `Activepieces property not found: ${options.actionName}.${options.propertyName}`,
    );
  }
  const resolver = property.props;
  if (property.type !== "DYNAMIC" || typeof resolver !== "function") {
    throw new Error(
      `${options.actionName}.${options.propertyName} is not a resolvable DYNAMIC property.`,
    );
  }

  const auth = resolvedCredentialToPieceAuth(
    options.credential,
    options.piece,
    options.apiKeyField === undefined
      ? {}
      : { apiKeyField: options.apiKeyField },
  );
  const routes = options.routes ?? [];
  const routedFetch = createRoutedFetch(options.fetchImpl, routes);
  const resolved = await runInsidePieceBoundary(
    { fetchImpl: options.fetchImpl, routes },
    options.boundary,
    routedFetch,
    () => resolver({ ...options.propsValue, auth }, propertyContext(options)),
  );
  return propsToJsonSchemaFromMap(resolved);
}
