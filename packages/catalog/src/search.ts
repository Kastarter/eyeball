import type { ToolDefinition } from "@eyeball/core";

export const DEFAULT_TOOL_SEARCH_LIMIT = 8;
export const MAX_TOOL_SEARCH_LIMIT = 20;
export const DEFAULT_BM25_WEIGHT = 0.8;
export const DEFAULT_EMBEDDING_WEIGHT = 0.2;

const BM25_K1 = 1.2;
const SYNONYM_TERM_WEIGHT = 0.85;
const SYNONYM_PRIORITY_DECAY = 0.45;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "someone",
  "something",
  "that",
  "the",
  "their",
  "them",
  "this",
  "to",
  "us",
  "want",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "would",
  "you",
  "your",
]);

export interface CatalogToolSearchOptions {
  query: string;
  limit?: number;
}

export interface HybridCatalogToolSearchOptions
  extends CatalogToolSearchOptions {
  /** Relative lexical contribution. The two weights are normalized before use. */
  bm25Weight?: number;
  /** Relative cosine-similarity contribution. The two weights are normalized before use. */
  embeddingWeight?: number;
}

/**
 * Provider contract for opt-in semantic search. The open-core catalog intentionally
 * ships no implementation, model, credentials, or network dependency.
 */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface ToolSearchSynonym {
  phrase: string;
  expansions: readonly string[];
}

/** Curated agent-speak intents expanded into vocabulary present in the catalog. */
export const TOOL_SEARCH_SYNONYMS: readonly ToolSearchSynonym[] = Object.freeze(
  [
    { phrase: "text someone", expansions: ["send_message"] },
    { phrase: "send a text", expansions: ["send_message"] },
    { phrase: "sms", expansions: ["send_message"] },
    { phrase: "email", expansions: ["send_email"] },
    { phrase: "write an email", expansions: ["create_draft"] },
    { phrase: "draft an email", expansions: ["create_draft"] },
    { phrase: "find an email", expansions: ["search_emails"] },
    {
      phrase: "book a meeting",
      expansions: ["create_event", "find_available_times"],
    },
    {
      phrase: "schedule a meeting",
      expansions: ["create_event", "find_available_times"],
    },
    { phrase: "find free time", expansions: ["find_available_times"] },
    { phrase: "accept calendar invite", expansions: ["respond_to_event"] },
    { phrase: "cancel a meeting", expansions: ["delete_event"] },
    { phrase: "rsvp", expansions: ["respond_to_event"] },
    {
      phrase: "call someone",
      expansions: ["start_call", "start_agent_call"],
    },
    {
      phrase: "make a phone call",
      expansions: ["start_call", "start_agent_call"],
    },
    { phrase: "voice agent call", expansions: ["start_agent_call"] },
    {
      phrase: "book a table",
      expansions: ["start_agent_call", "start_call"],
    },
    { phrase: "hang up", expansions: ["end_call"] },
    { phrase: "forward a call", expansions: ["transfer_call"] },
    {
      phrase: "scrape instagram",
      expansions: ["instagram-data.get_profile", "instagram-data.get_posts"],
    },
    {
      phrase: "get instagram",
      expansions: ["instagram-data.get_profile", "instagram-data.get_posts"],
    },
    {
      phrase: "tiktok creator posts",
      expansions: ["tiktok-data.get_posts"],
    },
    {
      phrase: "youtube channel videos",
      expansions: ["youtube-data.get_channel_videos"],
    },
    { phrase: "social profile", expansions: ["get_profile"] },
    { phrase: "social posts", expansions: ["get_posts"] },
    { phrase: "comments on a post", expansions: ["get_comments"] },
    { phrase: "video transcript", expansions: ["get_transcript"] },
    { phrase: "trending videos", expansions: ["get_trending_content"] },
    { phrase: "invoice", expansions: ["create_invoice"] },
    { phrase: "bill a customer", expansions: ["create_invoice"] },
    { phrase: "refund", expansions: ["create_refund"] },
    { phrase: "payment link", expansions: ["create_payment_link"] },
    { phrase: "cancel subscription", expansions: ["cancel_subscription"] },
    { phrase: "post to slack", expansions: ["slack.send_message"] },
    { phrase: "fulfill an order", expansions: ["create_fulfillment"] },
    { phrase: "add a note to the deal", expansions: ["hubspot.add_note"] },
    { phrase: "update a deal", expansions: ["update_deal"] },
    { phrase: "new contact", expansions: ["create_contact"] },
    { phrase: "find a contact", expansions: ["search_contacts"] },
    { phrase: "support request", expansions: ["create_ticket"] },
    { phrase: "answer a support ticket", expansions: ["add_ticket_reply"] },
    { phrase: "assign support case", expansions: ["assign_ticket"] },
    { phrase: "upload a document", expansions: ["upload_file"] },
    { phrase: "find a file", expansions: ["search_files"] },
    { phrase: "look up a file", expansions: ["search_files"] },
    { phrase: "share a document", expansions: ["share_file"] },
    { phrase: "add a row", expansions: ["append_row", "create_row"] },
    { phrase: "update spreadsheet cells", expansions: ["update_range"] },
    { phrase: "report a bug", expansions: ["create_issue"] },
    { phrase: "comment on an issue", expansions: ["add_comment"] },
  ],
);

export class CatalogToolSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogToolSearchInputError";
  }
}

const FIELD_DEFINITIONS = [
  { name: "name", boost: 5, lengthNormalization: 0.2 },
  { name: "toolkit", boost: 2.5, lengthNormalization: 0.2 },
  { name: "capability", boost: 1.75, lengthNormalization: 0.3 },
  { name: "description", boost: 1, lengthNormalization: 0.75 },
  { name: "inputNames", boost: 1.5, lengthNormalization: 0.4 },
  { name: "inputDescriptions", boost: 0.75, lengthNormalization: 0.75 },
] as const;

type FieldName = (typeof FIELD_DEFINITIONS)[number]["name"];
type FieldLengths = Record<FieldName, number>;
type FieldTerms = Record<FieldName, ReadonlyMap<string, number>>;

interface IndexedDocument {
  readonly tool: ToolDefinition;
  readonly fields: FieldTerms;
  readonly lengths: FieldLengths;
  readonly embeddingText: string;
}

interface ValidatedSearch {
  readonly query: string;
  readonly limit: number;
  readonly terms: ReadonlyMap<string, number>;
}

interface EmbeddingState {
  readonly vectors: readonly (readonly number[])[];
  readonly dimension: number;
}

type SearchIndexAccessor = () => CatalogToolSearchIndex;

const ARRAY_INDEX_CACHE = new WeakMap<object, CatalogToolSearchIndex>();
const TOOL_INDEX_ACCESSORS = new WeakMap<ToolDefinition, SearchIndexAccessor>();

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (
    token.length > 3 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

function allTokens(value: string): string[] {
  const splitCamelCase = value.replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return (splitCamelCase.toLowerCase().match(/[a-z0-9]+/gu) ?? []).map(
    stemToken,
  );
}

function meaningfulTokens(value: string): string[] {
  const all = allTokens(value);
  const meaningful = all.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length === 0 ? all : meaningful;
}

function containsSequence(
  tokens: readonly string[],
  sequence: readonly string[],
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    if (sequence.every((token, offset) => tokens[start + offset] === token)) {
      return true;
    }
  }
  return false;
}

const COMPILED_SYNONYMS = TOOL_SEARCH_SYNONYMS.map((entry) => ({
  phrase: meaningfulTokens(entry.phrase),
  expansions: entry.expansions.map((expansion, priority) => ({
    priority,
    tokens: [...new Set(meaningfulTokens(expansion))],
  })),
}));

function expandedQueryTerms(query: string): ReadonlyMap<string, number> {
  const weighted = new Map<string, number>();
  for (const token of meaningfulTokens(query)) {
    weighted.set(token, 1);
  }

  const queryTokens = meaningfulTokens(query);
  for (const synonym of COMPILED_SYNONYMS) {
    if (!containsSequence(queryTokens, synonym.phrase)) {
      continue;
    }
    for (const expansion of synonym.expansions) {
      const expansionWeight =
        SYNONYM_TERM_WEIGHT * SYNONYM_PRIORITY_DECAY ** expansion.priority;
      for (const token of expansion.tokens) {
        weighted.set(
          token,
          Math.max(weighted.get(token) ?? 0, expansionWeight),
        );
      }
    }
  }
  return weighted;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectInputSchemaText(
  schema: unknown,
  names: string[],
  descriptions: string[],
  visited: Set<object>,
): void {
  if (!isRecord(schema) || visited.has(schema)) {
    return;
  }
  visited.add(schema);

  if (typeof schema.description === "string") {
    descriptions.push(schema.description);
  }

  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      names.push(name);
      collectInputSchemaText(property, names, descriptions, visited);
    }
  }

  const singularChildren = [
    schema.additionalProperties,
    schema.contains,
    schema.else,
    schema.if,
    schema.items,
    schema.not,
    schema.propertyNames,
    schema.then,
    schema.unevaluatedProperties,
  ];
  for (const child of singularChildren) {
    collectInputSchemaText(child, names, descriptions, visited);
  }

  const arrayChildren = [
    schema.allOf,
    schema.anyOf,
    schema.oneOf,
    schema.prefixItems,
  ];
  for (const children of arrayChildren) {
    if (Array.isArray(children)) {
      for (const child of children) {
        collectInputSchemaText(child, names, descriptions, visited);
      }
    }
  }

  const keyedChildren = [
    schema.$defs,
    schema.definitions,
    schema.dependentSchemas,
  ];
  for (const children of keyedChildren) {
    if (isRecord(children)) {
      for (const child of Object.values(children)) {
        collectInputSchemaText(child, names, descriptions, visited);
      }
    }
  }
}

function termFrequencies(
  values: readonly string[],
): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const value of values) {
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  }
  return frequencies;
}

function indexDocument(tool: ToolDefinition): IndexedDocument {
  const inputNames: string[] = [];
  const inputDescriptions: string[] = [];
  collectInputSchemaText(
    tool.inputSchema,
    inputNames,
    inputDescriptions,
    new Set(),
  );

  const fieldTokens: Record<FieldName, string[]> = {
    name: meaningfulTokens(tool.name),
    toolkit: meaningfulTokens(tool.toolkit),
    capability: meaningfulTokens(tool.capability),
    description: meaningfulTokens(tool.description),
    inputNames: inputNames.flatMap(meaningfulTokens),
    inputDescriptions: inputDescriptions.flatMap(meaningfulTokens),
  };
  const fields: FieldTerms = {
    name: termFrequencies(fieldTokens.name),
    toolkit: termFrequencies(fieldTokens.toolkit),
    capability: termFrequencies(fieldTokens.capability),
    description: termFrequencies(fieldTokens.description),
    inputNames: termFrequencies(fieldTokens.inputNames),
    inputDescriptions: termFrequencies(fieldTokens.inputDescriptions),
  };
  const lengths: FieldLengths = {
    name: fieldTokens.name.length,
    toolkit: fieldTokens.toolkit.length,
    capability: fieldTokens.capability.length,
    description: fieldTokens.description.length,
    inputNames: fieldTokens.inputNames.length,
    inputDescriptions: fieldTokens.inputDescriptions.length,
  };

  return {
    tool,
    fields,
    lengths,
    embeddingText: [
      `Tool: ${tool.name}`,
      `Toolkit: ${tool.toolkit}`,
      `Capability: ${tool.capability}`,
      `Description: ${tool.description}`,
      `Input properties: ${inputNames.join(" ")}`,
      `Input descriptions: ${inputDescriptions.join(" ")}`,
    ].join("\n"),
  };
}

function validateSearchOptions(
  options: CatalogToolSearchOptions,
): ValidatedSearch {
  if (typeof options.query !== "string" || options.query.trim().length === 0) {
    throw new CatalogToolSearchInputError("query must be a non-empty string.");
  }
  const limit = options.limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOOL_SEARCH_LIMIT) {
    throw new CatalogToolSearchInputError(
      `limit must be an integer from 1 through ${MAX_TOOL_SEARCH_LIMIT}.`,
    );
  }
  const query = options.query.trim();
  return { query, limit, terms: expandedQueryTerms(query) };
}

function validatedWeight(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new CatalogToolSearchInputError(
      "BM25 and embedding weights must be non-negative finite numbers.",
    );
  }
  return resolved;
}

function validateEmbeddingVectors(
  vectors: readonly (readonly number[])[],
  expectedCount: number,
  expectedDimension?: number,
): number {
  if (vectors.length !== expectedCount) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${expectedCount} texts.`,
    );
  }
  const dimension = expectedDimension ?? vectors[0]?.length ?? 0;
  if (dimension < 1) {
    throw new Error("Embedding provider returned an empty vector.");
  }
  for (const vector of vectors) {
    if (
      vector.length !== dimension ||
      vector.some((component) => !Number.isFinite(component))
    ) {
      throw new Error(
        "Embedding provider must return finite vectors with one consistent dimension.",
      );
    }
  }
  return dimension;
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

/** A reusable immutable BM25F index over one materialized catalog generation. */
export class CatalogToolSearchIndex {
  readonly #documents: readonly IndexedDocument[];
  readonly #documentFrequency: ReadonlyMap<string, number>;
  readonly #averageLengths: FieldLengths;
  readonly #embeddingStates = new WeakMap<
    EmbeddingProvider,
    Promise<EmbeddingState>
  >();

  constructor(tools: readonly ToolDefinition[]) {
    this.#documents = [...tools]
      .sort((left, right) => compareNames(left.name, right.name))
      .map(indexDocument);

    const lengthTotals: FieldLengths = {
      name: 0,
      toolkit: 0,
      capability: 0,
      description: 0,
      inputNames: 0,
      inputDescriptions: 0,
    };
    const documentFrequency = new Map<string, number>();
    for (const document of this.#documents) {
      const terms = new Set<string>();
      for (const field of FIELD_DEFINITIONS) {
        lengthTotals[field.name] += document.lengths[field.name];
        for (const term of document.fields[field.name].keys()) {
          terms.add(term);
        }
      }
      for (const term of terms) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const count = Math.max(this.#documents.length, 1);
    this.#averageLengths = {
      name: lengthTotals.name / count,
      toolkit: lengthTotals.toolkit / count,
      capability: lengthTotals.capability / count,
      description: lengthTotals.description / count,
      inputNames: lengthTotals.inputNames / count,
      inputDescriptions: lengthTotals.inputDescriptions / count,
    };
    this.#documentFrequency = documentFrequency;
  }

  search(
    tools: readonly ToolDefinition[],
    options: CatalogToolSearchOptions,
  ): readonly ToolDefinition[] {
    const validated = validateSearchOptions(options);
    return this.#lexicalScores(tools, validated)
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareNames(left.tool.name, right.tool.name),
      )
      .slice(0, validated.limit)
      .map(({ tool }) => tool);
  }

  async searchHybrid(
    tools: readonly ToolDefinition[],
    options: HybridCatalogToolSearchOptions,
    provider: EmbeddingProvider,
  ): Promise<readonly ToolDefinition[]> {
    const validated = validateSearchOptions(options);
    const bm25Weight = validatedWeight(options.bm25Weight, DEFAULT_BM25_WEIGHT);
    const embeddingWeight = validatedWeight(
      options.embeddingWeight,
      DEFAULT_EMBEDDING_WEIGHT,
    );
    const totalWeight = bm25Weight + embeddingWeight;
    if (totalWeight === 0) {
      throw new CatalogToolSearchInputError(
        "At least one hybrid search weight must be greater than zero.",
      );
    }

    if (tools.length === 0) {
      return [];
    }

    const lexicalScores = this.#lexicalScores(tools, validated);
    const maximumBm25 = Math.max(0, ...lexicalScores.map(({ score }) => score));
    const candidateNames = new Map(tools.map((tool) => [tool.name, tool]));
    const embeddingState = await this.#embeddingState(provider);
    const queryVectors = await provider.embed([validated.query]);
    validateEmbeddingVectors(queryVectors, 1, embeddingState.dimension);
    const queryVector = queryVectors[0];
    if (queryVector === undefined) {
      throw new Error("Embedding provider did not return a query vector.");
    }
    const bm25ByName = new Map(
      lexicalScores.map(({ tool, score }) => [tool.name, score]),
    );

    return this.#documents
      .map((document, index) => {
        const tool = candidateNames.get(document.tool.name);
        if (tool === undefined) {
          return undefined;
        }
        const documentVector = embeddingState.vectors[index];
        if (documentVector === undefined) {
          throw new Error("Embedding index is missing a document vector.");
        }
        const bm25 = bm25ByName.get(tool.name) ?? 0;
        const normalizedBm25 = maximumBm25 === 0 ? 0 : bm25 / maximumBm25;
        const cosine = Math.max(
          0,
          cosineSimilarity(queryVector, documentVector),
        );
        return {
          tool,
          score:
            (bm25Weight * normalizedBm25 + embeddingWeight * cosine) /
            totalWeight,
        };
      })
      .filter(
        (result): result is { tool: ToolDefinition; score: number } =>
          result !== undefined && result.score > 0,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          compareNames(left.tool.name, right.tool.name),
      )
      .slice(0, validated.limit)
      .map(({ tool }) => tool);
  }

  #lexicalScores(
    tools: readonly ToolDefinition[],
    validated: ValidatedSearch,
  ): readonly { tool: ToolDefinition; score: number }[] {
    const candidateNames = new Map(tools.map((tool) => [tool.name, tool]));
    return this.#documents.flatMap((document) => {
      const tool = candidateNames.get(document.tool.name);
      if (tool === undefined) {
        return [];
      }
      return [{ tool, score: this.#bm25Score(document, validated.terms) }];
    });
  }

  #bm25Score(
    document: IndexedDocument,
    queryTerms: ReadonlyMap<string, number>,
  ): number {
    let score = 0;
    for (const [term, queryWeight] of queryTerms) {
      const frequency = this.#documentFrequency.get(term);
      if (frequency === undefined) {
        continue;
      }

      let weightedTermFrequency = 0;
      for (const field of FIELD_DEFINITIONS) {
        const termFrequency = document.fields[field.name].get(term) ?? 0;
        if (termFrequency === 0) {
          continue;
        }
        const averageLength = this.#averageLengths[field.name] || 1;
        const lengthRatio = document.lengths[field.name] / averageLength;
        const normalization =
          1 -
          field.lengthNormalization +
          field.lengthNormalization * lengthRatio;
        weightedTermFrequency += (field.boost * termFrequency) / normalization;
      }
      if (weightedTermFrequency === 0) {
        continue;
      }

      const documentCount = this.#documents.length;
      const inverseDocumentFrequency = Math.log(
        1 + (documentCount - frequency + 0.5) / (frequency + 0.5),
      );
      score +=
        queryWeight *
        inverseDocumentFrequency *
        ((weightedTermFrequency * (BM25_K1 + 1)) /
          (weightedTermFrequency + BM25_K1));
    }
    return score;
  }

  #embeddingState(provider: EmbeddingProvider): Promise<EmbeddingState> {
    const cached = this.#embeddingStates.get(provider);
    if (cached !== undefined) {
      return cached;
    }

    const pending = provider
      .embed(this.#documents.map(({ embeddingText }) => embeddingText))
      .then((vectors) => ({
        vectors,
        dimension: validateEmbeddingVectors(vectors, this.#documents.length),
      }))
      .catch((error: unknown) => {
        this.#embeddingStates.delete(provider);
        throw error;
      });
    this.#embeddingStates.set(provider, pending);
    return pending;
  }
}

function associatedSearchIndex(
  tools: readonly ToolDefinition[],
): CatalogToolSearchIndex | undefined {
  let sharedAccessor: SearchIndexAccessor | undefined;
  for (const tool of tools) {
    const accessor = TOOL_INDEX_ACCESSORS.get(tool);
    if (accessor === undefined) {
      return undefined;
    }
    if (sharedAccessor !== undefined && accessor !== sharedAccessor) {
      return undefined;
    }
    sharedAccessor = accessor;
  }
  return sharedAccessor?.();
}

function searchIndexFor(
  tools: readonly ToolDefinition[],
): CatalogToolSearchIndex {
  const associated = associatedSearchIndex(tools);
  if (associated !== undefined) {
    return associated;
  }
  const key = tools as object;
  const cached = ARRAY_INDEX_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const index = new CatalogToolSearchIndex(tools);
  ARRAY_INDEX_CACHE.set(key, index);
  return index;
}

/**
 * Associates materialized registry tools with the registry's lazy index accessor.
 * @internal
 */
export function associateCatalogToolsWithSearchIndex(
  tools: readonly ToolDefinition[],
  accessor: SearchIndexAccessor,
): void {
  for (const tool of tools) {
    TOOL_INDEX_ACCESSORS.set(tool, accessor);
  }
}

/** Deterministic BM25F search over an already policy-filtered catalog view. */
export function searchCatalogTools(
  tools: readonly ToolDefinition[],
  options: CatalogToolSearchOptions,
): readonly ToolDefinition[] {
  return searchIndexFor(tools).search(tools, options);
}

/** Opt-in hybrid BM25F + cosine search for deployments supplying embeddings. */
export async function searchCatalogToolsHybrid(
  tools: readonly ToolDefinition[],
  options: HybridCatalogToolSearchOptions,
  provider: EmbeddingProvider,
): Promise<readonly ToolDefinition[]> {
  return searchIndexFor(tools).searchHybrid(tools, options, provider);
}
