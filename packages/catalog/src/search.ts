import type { ToolDefinition } from "@eyeball/core";

export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const MAX_TOOL_SEARCH_LIMIT = 20;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

export interface CatalogToolSearchOptions {
  query: string;
  limit?: number;
}

export class CatalogToolSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogToolSearchInputError";
  }
}

function tokens(value: string): string[] {
  const all = value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const meaningful = all.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length === 0 ? all : meaningful;
}

function scoreTool(
  tool: ToolDefinition,
  queryTokens: readonly string[],
): number {
  const nameTokens = new Set(tokens(tool.name));
  const toolkitTokens = new Set(tokens(tool.toolkit));
  const capabilityTokens = new Set(tokens(tool.capability));
  const descriptionTokens = new Set(tokens(tool.description));
  const normalizedName = tool.name.toLowerCase().replaceAll(/[._-]/gu, " ");
  let matches = 0;
  let score = 0;

  for (const token of queryTokens) {
    let tokenScore = 0;
    if (nameTokens.has(token)) {
      tokenScore = 12;
    } else if (normalizedName.includes(token)) {
      tokenScore = 7;
    } else if (toolkitTokens.has(token)) {
      tokenScore = 5;
    } else if (capabilityTokens.has(token)) {
      tokenScore = 4;
    } else if (descriptionTokens.has(token)) {
      tokenScore = 3;
    } else if (tool.description.toLowerCase().includes(token)) {
      tokenScore = 1;
    }
    if (tokenScore > 0) {
      matches += 1;
      score += tokenScore;
    }
  }

  if (matches === 0) {
    return 0;
  }
  if (matches === queryTokens.length) {
    score += 20;
  }
  if (normalizedName.includes(queryTokens.join(" "))) {
    score += 10;
  }
  return score;
}

/** Deterministic lexical search over an already policy-filtered catalog view. */
export function searchCatalogTools(
  tools: readonly ToolDefinition[],
  options: CatalogToolSearchOptions,
): readonly ToolDefinition[] {
  if (typeof options.query !== "string" || options.query.trim().length === 0) {
    throw new CatalogToolSearchInputError("query must be a non-empty string.");
  }
  const limit = options.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_SEARCH_LIMIT) {
    throw new CatalogToolSearchInputError(
      `limit must be an integer from 1 through ${MAX_TOOL_SEARCH_LIMIT}.`,
    );
  }
  const queryTokens = [...new Set(tokens(options.query.trim()))];

  return tools
    .map((tool) => ({ tool, score: scoreTool(tool, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.tool.name.localeCompare(right.tool.name),
    )
    .slice(0, limit)
    .map(({ tool }) => tool);
}
