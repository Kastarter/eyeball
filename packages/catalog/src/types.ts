import type {
  AuthClass,
  CanonicalToolName,
  CapabilitySlug,
  DeliveryTier,
  ProviderSource,
  Toolkit,
} from "@eyeball/core";

/** A canonical operation frozen by the provider catalog, before schema materialization. */
export interface CanonicalToolCatalogEntry {
  name: CanonicalToolName;
  description: string;
}

/** One of the twenty catalog 1.0 capability namespaces. */
export interface CapabilityCatalogEntry {
  slug: CapabilitySlug;
  displayName: string;
  contractFocus: string;
  tools: readonly CanonicalToolCatalogEntry[];
}

/** A provider's documented membership in one capability matrix. */
export interface ProviderCapabilityMembership {
  capability: CapabilitySlug;
  notes: string;
}

/**
 * Complete roadmap metadata from docs/PROVIDERS.md.
 *
 * This is intentionally distinct from a ProviderManifest. A catalog entry describes
 * P0, P1, and P2 availability; a manifest publishes only a provider implementation
 * that has executable, versioned contracts.
 */
export interface ProviderCatalogEntry {
  toolkit: Toolkit;
  authClass: AuthClass;
  memberships: readonly ProviderCapabilityMembership[];
}

export interface CatalogSummary {
  capabilities: number;
  canonicalContracts: number;
  providers: number;
  tiers: Readonly<Record<DeliveryTier, number>>;
  sources: Readonly<Record<ProviderSource, number>>;
}
