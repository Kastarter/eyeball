import {
  CATALOG_SUMMARY,
  CATALOG_VERSION,
  defaultCatalog,
  PROVIDER_CATALOG,
} from "@eyeball/catalog";

const GROUP_DEFINITIONS = [
  {
    id: "email",
    label: "Email",
    description: "Mailboxes, threads, drafts, search, and delivery.",
    capabilities: ["email"],
  },
  {
    id: "messaging",
    label: "Messaging",
    description: "Chat, channels, replies, reactions, SMS, and verification.",
    capabilities: ["messaging_chat", "sms"],
  },
  {
    id: "voice",
    label: "Voice",
    description: "Calls, rooms, speech, realtime media, and agent sessions.",
    capabilities: ["voice_telephony"],
  },
  {
    id: "business",
    label: "Business",
    description: "CRM, ERP, billing, commerce, support, people, and growth.",
    capabilities: [
      "crm",
      "erp_accounting",
      "payments_billing",
      "ecommerce",
      "customer_support",
      "hr_recruiting",
      "marketing_ads",
      "sign_forms",
    ],
  },
  {
    id: "productivity",
    label: "Productivity",
    description:
      "Calendars, files, data, projects, search, and media utilities.",
    capabilities: [
      "calendar_scheduling",
      "file_storage_docs",
      "spreadsheets_databases",
      "project_management_dev_tools",
      "web_search_scraping",
      "ai_media_utilities",
    ],
  },
  {
    id: "social",
    label: "Social Data",
    description: "Public creator data plus account-authorized publishing.",
    capabilities: ["social_media_data", "social_media_publishing"],
  },
] as const;

export type ProviderGroupId = (typeof GROUP_DEFINITIONS)[number]["id"];

export interface LandingProvider {
  slug: string;
  displayName: string;
  implemented: boolean;
  runtimeOnly: boolean;
}

export interface LandingProviderGroup {
  id: ProviderGroupId;
  label: string;
  description: string;
  providers: readonly LandingProvider[];
}

const manifests = defaultCatalog.listManifests();
const implementedSlugs = new Set<string>(
  manifests.map(({ toolkit }) => toolkit.slug),
);
const roadmapSlugs = new Set<string>(
  PROVIDER_CATALOG.map(({ toolkit }) => toolkit.slug),
);

function groupForCapabilities(
  capabilities: readonly string[],
): ProviderGroupId {
  for (const definition of GROUP_DEFINITIONS) {
    if (
      capabilities.some((capability) =>
        (definition.capabilities as readonly string[]).includes(capability),
      )
    ) {
      return definition.id;
    }
  }
  throw new Error(`Provider has no landing group: ${capabilities.join(", ")}`);
}

const grouped = new Map<ProviderGroupId, LandingProvider[]>();
for (const definition of GROUP_DEFINITIONS) {
  grouped.set(definition.id, []);
}

for (const provider of PROVIDER_CATALOG) {
  const groupId = groupForCapabilities(
    provider.memberships.map(({ capability }) => capability),
  );
  grouped.get(groupId)?.push({
    slug: provider.toolkit.slug,
    displayName: provider.toolkit.displayName,
    implemented: implementedSlugs.has(provider.toolkit.slug),
    runtimeOnly: false,
  });
}

for (const manifest of manifests) {
  if (roadmapSlugs.has(manifest.toolkit.slug)) {
    continue;
  }
  const groupId = groupForCapabilities([
    ...manifest.implements.map(({ capability }) => capability),
    ...(manifest.triggers ?? []).map(({ capability }) => capability),
  ]);
  grouped.get(groupId)?.push({
    slug: manifest.toolkit.slug,
    displayName: manifest.toolkit.displayName,
    implemented: true,
    runtimeOnly: true,
  });
}

export const PROVIDER_GROUPS: readonly LandingProviderGroup[] =
  GROUP_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    description: definition.description,
    providers: (grouped.get(definition.id) ?? []).toSorted(
      (left, right) =>
        Number(right.implemented) - Number(left.implemented) ||
        left.displayName.localeCompare(right.displayName),
    ),
  }));

const implementedRoadmapProviders = PROVIDER_CATALOG.filter(({ toolkit }) =>
  implementedSlugs.has(toolkit.slug),
).length;

export const CATALOG_STATS = Object.freeze({
  catalogVersion: CATALOG_VERSION,
  capabilities: CATALOG_SUMMARY.capabilities,
  canonicalContracts: CATALOG_SUMMARY.canonicalContracts,
  roadmapProviders: CATALOG_SUMMARY.providers,
  implementedManifests: manifests.length,
  implementedRoadmapProviders,
  runtimeAdditions: manifests.length - implementedRoadmapProviders,
});
