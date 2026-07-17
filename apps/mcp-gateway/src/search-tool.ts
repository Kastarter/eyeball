import {
  DEFAULT_TOOL_SEARCH_LIMIT,
  MAX_TOOL_SEARCH_LIMIT,
  searchCatalogTools,
} from "@eyeball/catalog";
import type {
  JSONSchema202012,
  JsonValue,
  McpToolDescriptor,
  ObjectSchema202012,
  ToolDefinition,
} from "@eyeball/core";

export const SEARCH_TOOL_NAME = "eyeball.search_tools" as const;
export const DEFAULT_SEARCH_LIMIT = DEFAULT_TOOL_SEARCH_LIMIT;
export const MAX_SEARCH_LIMIT = MAX_TOOL_SEARCH_LIMIT;

export interface InputSchemaSummary {
  required: readonly string[];
  properties: Readonly<Record<string, string>>;
}

export interface ToolSearchCard {
  name: string;
  description: string;
  capability: string;
  toolkit: string;
  inputSchema: InputSchemaSummary;
}

export interface ToolSearchResult {
  tools: readonly ToolSearchCard[];
}

export class SearchToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchToolInputError";
  }
}

const searchInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "Natural-language keywords describing the tool to find.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
      default: DEFAULT_SEARCH_LIMIT,
      description: `Maximum result count from 1 through ${MAX_SEARCH_LIMIT}.`,
    },
  },
} satisfies ObjectSchema202012;

const schemaSummarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["required", "properties"],
  properties: {
    required: { type: "array", items: { type: "string" } },
    properties: {
      type: "object",
      additionalProperties: { type: "string" },
    },
  },
} satisfies ObjectSchema202012;

const searchOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tools"],
  properties: {
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "description",
          "capability",
          "toolkit",
          "inputSchema",
        ],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          capability: { type: "string" },
          toolkit: { type: "string" },
          inputSchema: schemaSummarySchema,
        },
      },
    },
  },
} satisfies ObjectSchema202012;

/**
 * The one built-in gateway tool. It deliberately stays small so lean listings can
 * defer the much larger project catalog until an agent describes what it needs.
 */
export const searchToolDescriptor: McpToolDescriptor = {
  name: SEARCH_TOOL_NAME,
  description:
    "Search the enabled Eyeball catalog by intent. Returns compact canonical tool cards with schema summaries; call it before requesting a provider tool when the catalog is large.",
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalar(value: JsonValue): string {
  const rendered = JSON.stringify(value);
  return rendered.length > 24 ? `${rendered.slice(0, 21)}...` : rendered;
}

function schemaType(schema: JSONSchema202012 | undefined): string {
  if (schema === undefined || schema === true) {
    return "any";
  }
  if (schema === false) {
    return "never";
  }
  if (schema.enum !== undefined) {
    const choices = schema.enum.slice(0, 4).map(scalar);
    if (schema.enum.length > choices.length) {
      choices.push("...");
    }
    return `enum(${choices.join(" | ")})`;
  }
  if (schema.$ref !== undefined) {
    return "reference";
  }
  if (schema.type !== undefined && typeof schema.type !== "string") {
    return schema.type.join(" | ");
  }
  if (schema.type === "array") {
    return `array<${schemaType(schema.items)}>`;
  }
  return schema.type ?? "any";
}

export function summarizeInputSchema(
  schema: ObjectSchema202012,
): InputSchemaSummary {
  return {
    required: [...(schema.required ?? [])],
    properties: Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, property]) => [name, schemaType(property)]),
    ),
  };
}

function parseInput(input: unknown): { query: string; limit: number } {
  if (!isRecord(input)) {
    throw new SearchToolInputError("Search input must be a JSON object.");
  }
  const unknownKey = Object.keys(input).find(
    (key) => key !== "query" && key !== "limit",
  );
  if (unknownKey !== undefined) {
    throw new SearchToolInputError(
      `Unknown search input field: ${unknownKey}.`,
    );
  }
  if (typeof input.query !== "string" || input.query.trim().length === 0) {
    throw new SearchToolInputError("query must be a non-empty string.");
  }
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SEARCH_LIMIT
  ) {
    throw new SearchToolInputError(
      `limit must be an integer from 1 through ${MAX_SEARCH_LIMIT}.`,
    );
  }
  return { query: input.query.trim(), limit };
}

export function searchTools(
  tools: readonly ToolDefinition[],
  input: unknown,
): ToolSearchResult {
  const { query, limit } = parseInput(input);

  return {
    tools: searchCatalogTools(tools, { query, limit }).map((tool) => ({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      toolkit: tool.toolkit,
      inputSchema: summarizeInputSchema(tool.inputSchema),
    })),
  };
}
