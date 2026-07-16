import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const hubSpotManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "hubspot",
    displayName: "HubSpot",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
  },
  endpoint: {
    baseUrl: "https://api.hubapi.com",
    baseUrlOverrideEnv: "EYEBALL_HUBSPOT_BASE_URL",
  },
  implements: [
    {
      capability: "crm",
      canonicalTool: "create_contact",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.contacts.create",
    },
    {
      capability: "crm",
      canonicalTool: "get_contact",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.contacts.getById",
    },
    {
      capability: "crm",
      canonicalTool: "search_contacts",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.contacts.search",
    },
    {
      capability: "crm",
      canonicalTool: "update_contact",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.contacts.update",
    },
    {
      capability: "crm",
      canonicalTool: "create_company",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.companies.create",
    },
    {
      capability: "crm",
      canonicalTool: "update_company",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.companies.update",
    },
    {
      capability: "crm",
      canonicalTool: "create_deal",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.deals.create",
    },
    {
      capability: "crm",
      canonicalTool: "update_deal",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.deals.update",
    },
    {
      capability: "crm",
      canonicalTool: "add_note",
      canonicalVersion: "1.0.0",
      operationId: "crm.objects.notes.create",
    },
  ],
} as const satisfies ProviderManifest);
