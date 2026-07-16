import type {
  CapabilitySlug,
  DeliveryTier,
  ProviderSource,
} from "@eyeball/core";
import { CAPABILITY_CATALOG, PROVIDER_CATALOG } from "./baseline.generated.js";
import { deepFreeze } from "./immutable.js";
import type {
  CapabilityCatalogEntry,
  CatalogSummary,
  ProviderCatalogEntry,
} from "./types.js";

/** Current additive catalog release. The generated 1.0 baseline remains frozen below. */
export const CATALOG_VERSION = "1.1" as const;
export const CATALOG_SNAPSHOT_DATE = "2026-07-16" as const;

const capabilitiesBySlug = new Map<CapabilitySlug, CapabilityCatalogEntry>(
  CAPABILITY_CATALOG.map((capability) => [capability.slug, capability]),
);
const providersBySlug = new Map<string, ProviderCatalogEntry>(
  PROVIDER_CATALOG.map((provider) => [provider.toolkit.slug, provider]),
);

function countProvidersBy<T extends DeliveryTier | ProviderSource>(
  values: readonly T[],
  select: (provider: ProviderCatalogEntry) => T,
): Readonly<Record<T, number>> {
  return Object.freeze(
    Object.fromEntries(
      values.map((value) => [
        value,
        PROVIDER_CATALOG.filter((provider) => select(provider) === value)
          .length,
      ]),
    ) as Record<T, number>,
  );
}

export const CATALOG_SUMMARY: CatalogSummary = deepFreeze({
  capabilities: CAPABILITY_CATALOG.length,
  canonicalContracts: CAPABILITY_CATALOG.reduce(
    (total, capability) => total + capability.tools.length,
    0,
  ),
  providers: PROVIDER_CATALOG.length,
  tiers: countProvidersBy(
    ["P0", "P1", "P2"],
    (provider) => provider.toolkit.tier,
  ),
  sources: countProvidersBy(
    ["activepieces-bridge", "native", "scrapecreators"],
    (provider) => provider.toolkit.source,
  ),
});

export const P0_PROVIDER_CATALOG = deepFreeze(
  PROVIDER_CATALOG.filter((provider) => provider.toolkit.tier === "P0"),
);

export function getCapabilityCatalogEntry(
  slug: CapabilitySlug,
): CapabilityCatalogEntry | undefined {
  return capabilitiesBySlug.get(slug);
}

export function getProviderCatalogEntry(
  slug: string,
): ProviderCatalogEntry | undefined {
  return providersBySlug.get(slug);
}

export { CAPABILITY_CATALOG, PROVIDER_CATALOG };
