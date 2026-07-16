import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const stripeManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.0",
  toolkit: {
    slug: "stripe",
    displayName: "Stripe",
    source: "activepieces-bridge",
    tier: "P0",
  },
  auth: {
    class: "api_key",
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.stripe.com",
    baseUrlOverrideEnv: "EYEBALL_STRIPE_BASE_URL",
  },
  implements: [
    {
      capability: "payments_billing",
      canonicalTool: "create_payment_link",
      canonicalVersion: "1.0.0",
      operationId: "paymentLinks.create",
    },
    {
      capability: "payments_billing",
      canonicalTool: "get_payment",
      canonicalVersion: "1.0.0",
      operationId: "charges.retrieve",
    },
    {
      capability: "payments_billing",
      canonicalTool: "list_payments",
      canonicalVersion: "1.0.0",
      operationId: "charges.list",
    },
    {
      capability: "payments_billing",
      canonicalTool: "create_refund",
      canonicalVersion: "1.0.0",
      operationId: "refunds.create",
    },
    {
      capability: "payments_billing",
      canonicalTool: "create_customer",
      canonicalVersion: "1.0.0",
      operationId: "customers.create",
    },
    {
      capability: "payments_billing",
      canonicalTool: "get_customer",
      canonicalVersion: "1.0.0",
      operationId: "customers.retrieve",
    },
    {
      capability: "payments_billing",
      canonicalTool: "list_subscriptions",
      canonicalVersion: "1.0.0",
      operationId: "subscriptions.list",
    },
    {
      capability: "payments_billing",
      canonicalTool: "cancel_subscription",
      canonicalVersion: "1.0.0",
      operationId: "subscriptions.cancel",
    },
    {
      capability: "payments_billing",
      canonicalTool: "create_invoice",
      canonicalVersion: "1.0.0",
      operationId: "invoices.create",
    },
    {
      capability: "payments_billing",
      canonicalTool: "get_invoice",
      canonicalVersion: "1.0.0",
      operationId: "invoices.retrieve",
    },
  ],
} as const satisfies ProviderManifest);
