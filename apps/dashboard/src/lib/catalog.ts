import {
  CATALOG_VERSION,
  defaultCatalog,
  getCapabilityCatalogEntry,
} from "@eyeball/catalog";

export type CatalogJsonPrimitive = null | boolean | number | string;

export type CatalogSchema =
  | boolean
  | {
      default?: unknown;
      description?: string;
      enum?: readonly CatalogJsonPrimitive[];
      format?: string;
      items?: CatalogSchema;
      properties?: Readonly<Record<string, CatalogSchema>>;
      required?: readonly string[];
      title?: string;
      type?:
        | "null"
        | "boolean"
        | "object"
        | "array"
        | "number"
        | "integer"
        | "string"
        | readonly string[];
      [keyword: string]: unknown;
    };

export interface CatalogToolView {
  annotations: {
    async: boolean;
    destructive: boolean;
    idempotent: boolean;
    readOnly: boolean;
  };
  capability: string;
  description: string;
  inputSchema: CatalogSchema;
  name: string;
  outputSchema?: CatalogSchema;
  version: string;
}

export interface CatalogToolkitSummary {
  authClass: string;
  authFields: readonly string[];
  capabilities: readonly { label: string; slug: string }[];
  displayName: string;
  slug: string;
  sourceLabel: "bridge" | "native" | "scrapecreators";
  tier: string;
  toolCount: number;
}

export interface CatalogToolkitView {
  auth: {
    class: string;
    fields: readonly string[];
    optionalScopes: readonly string[];
    requiredScopes: readonly string[];
  };
  capabilities: readonly { label: string; slug: string }[];
  displayName: string;
  slug: string;
  source: string;
  sourceLabel: "bridge" | "native" | "scrapecreators";
  tier: string;
  tools: readonly CatalogToolView[];
}

export interface CatalogSearchTool {
  capability: string;
  name: string;
  toolkit: string;
}

export interface CatalogCommandIndex {
  toolkits: readonly {
    capabilities: readonly { label: string; slug: string }[];
    displayName: string;
    slug: string;
    sourceLabel: CatalogToolkitView["sourceLabel"];
  }[];
  tools: readonly CatalogSearchTool[];
}

export interface CatalogMetrics {
  toolkits: number;
  tools: number;
  version: string;
}

export interface CatalogWebhookTriggerOption {
  description: string;
  label: string;
  toolkit: string;
  value: `trigger.${string}`;
}

export function getCatalogMetrics(): CatalogMetrics {
  return {
    toolkits: defaultCatalog.listToolkits().length,
    tools: defaultCatalog.listTools().length,
    version: CATALOG_VERSION,
  };
}

export function getCatalogWebhookTriggerOptions(): readonly CatalogWebhookTriggerOption[] {
  return defaultCatalog.listTriggers().map((trigger) => ({
    description: trigger.description,
    label: trigger.name,
    toolkit: trigger.toolkit,
    value: `trigger.${trigger.name}`,
  }));
}

function sourceLabel(source: string): CatalogToolkitView["sourceLabel"] {
  if (source === "native") return "native";
  if (source === "scrapecreators") return "scrapecreators";
  return "bridge";
}

type CatalogProviderManifest = ReturnType<
  typeof defaultCatalog.listManifests
>[number];

function capabilityViews(
  manifest: CatalogProviderManifest,
): readonly { label: string; slug: string }[] {
  const capabilitySlugs = [
    ...new Set(manifest.implements.map((tool) => tool.capability)),
  ].sort();
  return capabilitySlugs.map((slug) => ({
    label: getCapabilityCatalogEntry(slug)?.displayName ?? slug,
    slug,
  }));
}

function toolkitView(manifest: CatalogProviderManifest): CatalogToolkitView {
  const tools = defaultCatalog.listTools({ toolkit: manifest.toolkit.slug });
  return {
    auth: {
      class: manifest.auth.class,
      fields: manifest.auth.fields ?? [],
      optionalScopes: manifest.auth.optionalScopes ?? [],
      requiredScopes: manifest.auth.requiredScopes ?? [],
    },
    capabilities: capabilityViews(manifest),
    displayName: manifest.toolkit.displayName,
    slug: manifest.toolkit.slug,
    source: manifest.toolkit.source,
    sourceLabel: sourceLabel(manifest.toolkit.source),
    tier: manifest.toolkit.tier,
    tools: tools.map((tool) => ({
      annotations: { ...tool.annotations },
      capability: tool.capability,
      description: tool.description,
      inputSchema: structuredClone(tool.inputSchema) as CatalogSchema,
      name: tool.name,
      ...(tool.outputSchema === undefined
        ? {}
        : {
            outputSchema: structuredClone(tool.outputSchema) as CatalogSchema,
          }),
      version: tool.version,
    })),
  };
}

export function getCatalogToolkits(): readonly CatalogToolkitView[] {
  return defaultCatalog.listManifests().map(toolkitView);
}

export function getCatalogToolkit(
  slug: string,
): CatalogToolkitView | undefined {
  const manifest = defaultCatalog.getManifest(slug);
  return manifest === undefined ? undefined : toolkitView(manifest);
}

export function getCatalogToolkitSummaries(): readonly CatalogToolkitSummary[] {
  return defaultCatalog.listManifests().map((manifest) => ({
    authClass: manifest.auth.class,
    authFields: manifest.auth.fields ?? [],
    capabilities: capabilityViews(manifest),
    displayName: manifest.toolkit.displayName,
    slug: manifest.toolkit.slug,
    sourceLabel: sourceLabel(manifest.toolkit.source),
    tier: manifest.toolkit.tier,
    toolCount: manifest.implements.length,
  }));
}

export function getCatalogCommandIndex(): CatalogCommandIndex {
  const manifests = defaultCatalog.listManifests();
  return {
    toolkits: manifests.map((manifest) => ({
      capabilities: capabilityViews(manifest),
      displayName: manifest.toolkit.displayName,
      slug: manifest.toolkit.slug,
      sourceLabel: sourceLabel(manifest.toolkit.source),
    })),
    tools: manifests.flatMap((manifest) =>
      manifest.implements.map((tool) => ({
        capability: tool.capability,
        name: `${manifest.toolkit.slug}.${tool.canonicalTool}`,
        toolkit: manifest.toolkit.slug,
      })),
    ),
  };
}
