import type { JSONSchema202012, ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

const realmExtension = {
  type: "object",
  description: "QuickBooks company context for the operation.",
  additionalProperties: false,
  required: ["realmId"],
  properties: {
    realmId: {
      type: "string",
      description: "QuickBooks Online company realm identifier.",
      minLength: 1,
    },
  },
} as const satisfies JSONSchema202012;

export const quickBooksManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "quickbooks",
    displayName: "QuickBooks Online",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "oauth2",
    optionalScopes: ["com.intuit.quickbooks.accounting"],
  },
  endpoint: {
    baseUrl: "https://quickbooks.api.intuit.com",
    baseUrlOverrideEnv: "EYEBALL_QUICKBOOKS_BASE_URL",
  },
  implements: [
    {
      capability: "erp_accounting",
      canonicalTool: "list_customers",
      canonicalVersion: "1.0.0",
      operationId: "query.Customer",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "create_customer",
      canonicalVersion: "1.0.0",
      operationId: "Customer.create",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "list_invoices",
      canonicalVersion: "1.0.0",
      operationId: "query.Invoice",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "get_invoice",
      canonicalVersion: "1.0.0",
      operationId: "Invoice.read",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "create_invoice",
      canonicalVersion: "1.0.0",
      operationId: "Invoice.create",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "send_invoice",
      canonicalVersion: "1.0.0",
      operationId: "Invoice.send",
      inputExtensionSchema: realmExtension,
    },
    {
      capability: "erp_accounting",
      canonicalTool: "record_payment",
      canonicalVersion: "1.0.0",
      operationId: "Payment.create",
      inputExtensionSchema: realmExtension,
    },
  ],
} as const satisfies ProviderManifest);
