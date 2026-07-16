import type { ToolkitAdapter } from "@eyeball/core";
import { hubSpotAdapter } from "./hubspot.js";
import { odooAdapter } from "./odoo.js";
import { quickBooksAdapter } from "./quickbooks.js";
import { shopifyAdapter } from "./shopify.js";
import { stripeAdapter } from "./stripe.js";
import { zendeskAdapter } from "./zendesk.js";

export * from "./hubspot.js";
export * from "./odoo.js";
export * from "./quickbooks.js";
export * from "./shopify.js";
export * from "./stripe.js";
export * from "./zendesk.js";

export const businessToolkitAdapters = Object.freeze([
  hubSpotAdapter,
  odooAdapter,
  quickBooksAdapter,
  stripeAdapter,
  shopifyAdapter,
  zendeskAdapter,
] as const satisfies readonly ToolkitAdapter[]);
