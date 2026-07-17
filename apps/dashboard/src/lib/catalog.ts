import { CATALOG_VERSION, defaultCatalog } from "@eyeball/catalog";

export interface CatalogMetrics {
  toolkits: number;
  tools: number;
  version: string;
}

export function getCatalogMetrics(): CatalogMetrics {
  return {
    toolkits: defaultCatalog.listToolkits().length,
    tools: defaultCatalog.listTools().length,
    version: CATALOG_VERSION,
  };
}
