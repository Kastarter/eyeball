import type { CatalogSearchTool, CatalogToolkitView } from "./catalog";

interface CatalogSearchEnvelope {
  tools: readonly CatalogSearchTool[];
}

function isSearchTool(value: unknown): value is CatalogSearchTool {
  return (
    typeof value === "object" &&
    value !== null &&
    "capability" in value &&
    "name" in value &&
    "toolkit" in value &&
    typeof value.capability === "string" &&
    typeof value.name === "string" &&
    typeof value.toolkit === "string"
  );
}

export async function searchCatalogTools(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly CatalogSearchTool[]> {
  const parameters = new URLSearchParams({ q: query });
  const response = await fetchImpl(`/api/catalog/search?${parameters}`, {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Catalog search failed with HTTP ${response.status}.`);
  }
  const value = (await response.json()) as Partial<CatalogSearchEnvelope>;
  if (!Array.isArray(value.tools) || !value.tools.every(isSearchTool)) {
    throw new Error("Catalog search returned an invalid response.");
  }
  return value.tools;
}

export async function loadCatalogToolkit(
  slug: string,
  signal?: AbortSignal,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CatalogToolkitView> {
  const response = await fetchImpl(
    `/api/catalog/toolkits/${encodeURIComponent(slug)}`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (!response.ok) {
    throw new Error(`Toolkit detail failed with HTTP ${response.status}.`);
  }
  const value = (await response.json()) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("slug" in value) ||
    !("displayName" in value) ||
    !("auth" in value) ||
    !("tools" in value) ||
    value.slug !== slug ||
    typeof value.displayName !== "string" ||
    typeof value.auth !== "object" ||
    value.auth === null ||
    !Array.isArray(value.tools)
  ) {
    throw new Error("Toolkit detail returned an invalid response.");
  }
  return value as CatalogToolkitView;
}
