import { emailCapabilityContracts } from "./capabilities/email.js";
import { CATALOG_VERSION } from "./catalog.js";
import { gmailManifest } from "./manifests/gmail.js";
import { CatalogRegistry } from "./registry.js";

/** The materialized catalog shipped by the open-core runtime. */
export const defaultCatalog = new CatalogRegistry({
  catalogVersion: CATALOG_VERSION,
  contracts: emailCapabilityContracts,
  manifests: [gmailManifest],
});
