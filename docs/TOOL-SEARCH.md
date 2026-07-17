# Tool search ranking

Eyeball tool search is local and deterministic by default. The TypeScript SDK's
`eb.tools.search` and the MCP gateway's `eyeball.search_tools` keep their existing
interfaces and use the same catalog ranker.

## Lexical index

Each `CatalogRegistry` builds its search index lazily on the first search and reuses it
for catalog views returned by `listTools`, including filtered views. Registering a new
contract or provider manifest invalidates the index; the next search rebuilds it once
from the new catalog generation.

The index lowercases text, splits camel case and non-alphanumeric separators, removes
common agent-prompt stop words, and applies conservative plural stemming. It indexes
the following fields with BM25F boosts and per-field length normalization:

| Field | Boost | Length normalization |
| --- | ---: | ---: |
| Qualified tool name | 5.00 | 0.20 |
| Toolkit slug | 2.50 | 0.20 |
| Capability | 1.75 | 0.30 |
| Input property names | 1.50 | 0.40 |
| Tool description | 1.00 | 0.75 |
| Input property descriptions | 0.75 | 0.75 |

Document frequency is computed across the catalog generation. BM25F uses `k1 = 1.2`,
and canonical tool name is the deterministic tie-breaker.

## Intent expansion

A curated table maps common agent wording to canonical catalog vocabulary. It covers
email and messaging, calendar scheduling, voice calls, social-data retrieval, billing,
CRM, support, files, spreadsheets, and project-management intents. Exact query terms
have weight `1`; expanded terms have a lower weight and later alternative targets are
decayed so the first canonical intent remains primary. Phrase matching ignores prompt
filler words, so both “find an email” and “find the email” activate `search_emails`.

The table is deliberately small and catalog-grounded. Additions should include a
top-three relevance fixture in `packages/catalog/test/search.test.ts`.

## Optional embeddings

The catalog exposes only a provider seam; it does not ship a model, model download,
credential, network client, or embedding dependency:

```ts
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
```

A deployment can configure a registry for asynchronous hybrid search:

```ts
import { CatalogRegistry } from "@eyeball/catalog";

const catalog = new CatalogRegistry({
  contracts,
  manifests,
  embeddingProvider: deploymentEmbeddingProvider,
});

const tools = await catalog.searchTools({ query: "refund the customer" });
```

Callers that already own a materialized tool view can use
`searchCatalogToolsHybrid(tools, options, provider)` directly. The default hybrid mix is
80% normalized BM25F and 20% non-negative cosine similarity; callers may override both
weights. Document vectors are embedded once per provider and catalog generation, while
each query is embedded at search time. Providers must return one finite, consistently
sized vector per input text.

Cloud and other real deployments are responsible for adapting their embedding service
to `EmbeddingProvider`, including authentication, batching, retries, rate limits, and
model/version pinning. The test suite uses a deterministic local hash provider only to
exercise ranking, vector validation, caching, and invalidation without network access.
