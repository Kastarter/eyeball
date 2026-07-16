import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const shopifyManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "shopify",
    displayName: "Shopify",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    optionalScopes: [
      "read_products",
      "write_products",
      "read_orders",
      "write_fulfillments",
      "write_inventory",
    ],
  },
  endpoint: {
    baseUrl: "https://shopify.invalid",
    baseUrlOverrideEnv: "EYEBALL_SHOPIFY_BASE_URL",
  },
  implements: [
    {
      capability: "ecommerce",
      canonicalTool: "list_products",
      canonicalVersion: "1.0.0",
      operationId: "products.list",
    },
    {
      capability: "ecommerce",
      canonicalTool: "get_product",
      canonicalVersion: "1.0.0",
      operationId: "products.get",
    },
    {
      capability: "ecommerce",
      canonicalTool: "create_product",
      canonicalVersion: "1.0.0",
      operationId: "products.create",
    },
    {
      capability: "ecommerce",
      canonicalTool: "update_product",
      canonicalVersion: "1.0.0",
      operationId: "products.update",
    },
    {
      capability: "ecommerce",
      canonicalTool: "update_inventory",
      canonicalVersion: "1.0.0",
      operationId: "inventoryLevels.set",
    },
    {
      capability: "ecommerce",
      canonicalTool: "list_orders",
      canonicalVersion: "1.0.0",
      operationId: "orders.list",
    },
    {
      capability: "ecommerce",
      canonicalTool: "get_order",
      canonicalVersion: "1.0.0",
      operationId: "orders.get",
    },
    {
      capability: "ecommerce",
      canonicalTool: "update_order",
      canonicalVersion: "1.0.0",
      operationId: "orders.update",
    },
    {
      capability: "ecommerce",
      canonicalTool: "create_fulfillment",
      canonicalVersion: "1.0.0",
      operationId: "fulfillments.create",
    },
    {
      capability: "ecommerce",
      canonicalTool: "list_customers",
      canonicalVersion: "1.0.0",
      operationId: "customers.list",
    },
  ],
} as const satisfies ProviderManifest);
