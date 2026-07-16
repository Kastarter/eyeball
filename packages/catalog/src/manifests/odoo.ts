import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const odooManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "odoo",
    displayName: "Odoo",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "basic",
    fields: ["database", "username", "apiKey"],
  },
  endpoint: {
    baseUrl: "https://odoo.invalid",
    baseUrlOverrideEnv: "EYEBALL_ODOO_BASE_URL",
  },
  implements: [
    {
      capability: "erp_accounting",
      canonicalTool: "list_customers",
      canonicalVersion: "1.0.0",
      operationId: "res.partner.search_read",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "create_customer",
      canonicalVersion: "1.0.0",
      operationId: "res.partner.create",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "list_invoices",
      canonicalVersion: "1.0.0",
      operationId: "account.move.search_read",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "get_invoice",
      canonicalVersion: "1.0.0",
      operationId: "account.move.search_readById",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "create_invoice",
      canonicalVersion: "1.0.0",
      operationId: "account.move.create",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "send_invoice",
      canonicalVersion: "1.0.0",
      operationId: "account.move.action_post",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "list_bills",
      canonicalVersion: "1.0.0",
      operationId: "account.move.search_read.vendorBills",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "create_bill",
      canonicalVersion: "1.0.0",
      operationId: "account.move.create.vendorBill",
    },
    {
      capability: "erp_accounting",
      canonicalTool: "search_erp_records",
      canonicalVersion: "1.0.0",
      operationId: "object.execute_kw.search_read",
    },
  ],
} as const satisfies ProviderManifest);
