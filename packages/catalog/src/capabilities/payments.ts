import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "payments_billing" as const;
const VERSION = "1.0.0" as const;

const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;
const CREATE = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
} as const;
const DESTRUCTIVE_CREATE = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  async: false,
} as const;
const DESTRUCTIVE_UPDATE = {
  readOnly: false,
  destructive: true,
  idempotent: true,
  async: false,
} as const;

function id(description: string): JSONSchema202012 {
  return { type: "string", description, minLength: 1 };
}

function currency(): JSONSchema202012 {
  return {
    type: "string",
    description: "ISO 4217 currency code.",
    pattern: "^[A-Z]{3}$",
  };
}

function metadata(description: string): JSONSchema202012 {
  return {
    type: "object",
    description,
    additionalProperties: { type: ["string", "number", "boolean", "null"] },
  };
}

function paymentSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized payment, charge, or transaction.",
    additionalProperties: false,
    required: ["paymentId", "amount", "currency", "status", "createdAt"],
    properties: {
      paymentId: id("Provider identifier of the payment."),
      amount: {
        type: "integer",
        description: "Payment amount in the currency's smallest unit.",
        minimum: 0,
      },
      currency: currency(),
      status: { type: "string", description: "Payment state." },
      customerId: id("Provider identifier of the billing customer."),
      description: { type: "string", description: "Payment description." },
      captured: {
        type: "boolean",
        description: "Whether the payment was captured.",
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Payment creation timestamp.",
      },
    },
  };
}

function customerSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized billing customer.",
    additionalProperties: false,
    required: ["customerId", "createdAt"],
    properties: {
      customerId: id("Provider identifier of the billing customer."),
      name: { type: "string", description: "Customer display name." },
      email: {
        type: "string",
        format: "email",
        description: "Customer email address.",
      },
      phone: { type: "string", description: "Customer phone number." },
      metadata: metadata("Portable customer metadata."),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Customer creation timestamp.",
      },
    },
  };
}

function subscriptionSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized billing subscription.",
    additionalProperties: false,
    required: [
      "subscriptionId",
      "customerId",
      "status",
      "cancelAtPeriodEnd",
      "createdAt",
    ],
    properties: {
      subscriptionId: id("Provider identifier of the subscription."),
      customerId: id("Provider identifier of the billing customer."),
      status: { type: "string", description: "Subscription state." },
      cancelAtPeriodEnd: {
        type: "boolean",
        description: "Whether cancellation is scheduled for period end.",
      },
      canceledAt: {
        type: "string",
        format: "date-time",
        description: "Cancellation timestamp when canceled.",
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Subscription creation timestamp.",
      },
    },
  };
}

const createPaymentLink = defineContract({
  capability: CAPABILITY,
  name: "create_payment_link",
  description:
    "Create a hosted checkout or payment link for a fixed amount. This creates a shareable external payment surface; verify amount and currency first.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_payment_link",
    direction: "input",
    description:
      "Amount, currency, and optional customer context for a hosted payment link.",
    required: ["amount", "currency"],
    properties: {
      amount: {
        type: "integer",
        description: "Amount in the currency's smallest unit.",
        minimum: 1,
      },
      currency: currency(),
      description: {
        type: "string",
        description: "Customer-facing payment description.",
        minLength: 1,
      },
      customerId: id("Provider identifier of an existing billing customer."),
      metadata: metadata(
        "Portable metadata to associate with the payment link.",
      ),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_payment_link",
    direction: "output",
    description: "The newly created hosted payment link.",
    required: [
      "paymentLinkId",
      "url",
      "status",
      "amount",
      "currency",
      "createdAt",
    ],
    properties: {
      paymentLinkId: id("Provider identifier of the payment link."),
      url: {
        type: "string",
        format: "uri",
        description: "Hosted checkout URL.",
      },
      status: { type: "string", description: "Payment-link state." },
      amount: {
        type: "integer",
        description: "Amount in the currency's smallest unit.",
        minimum: 0,
      },
      currency: currency(),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Payment-link creation timestamp.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getPayment = defineContract({
  capability: CAPABILITY,
  name: "get_payment",
  description:
    "Retrieve one payment, charge, or transaction and its current status.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_payment",
    direction: "input",
    description: "Identifier of the payment to retrieve.",
    required: ["paymentId"],
    properties: { paymentId: id("Provider identifier of the payment.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_payment",
    direction: "output",
    description: "The requested normalized payment.",
    required: ["payment"],
    properties: { payment: paymentSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const listPayments = defineContract({
  capability: CAPABILITY,
  name: "list_payments",
  description:
    "List payments using customer, status, time, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_payments",
    direction: "input",
    description: "Payment filters and pagination.",
    properties: {
      customerId: id("Provider identifier of the billing customer."),
      status: {
        type: "string",
        description: "Payment state to match.",
        minLength: 1,
      },
      createdAfter: {
        type: "string",
        format: "date-time",
        description: "Return payments created at or after this timestamp.",
      },
      createdBefore: {
        type: "string",
        format: "date-time",
        description: "Return payments created before this timestamp.",
      },
      pageSize: pageSizeProperty("payments"),
      pageToken: pageTokenProperty("payment"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_payments",
    direction: "output",
    description: "One page of normalized payments.",
    required: ["payments"],
    properties: {
      payments: {
        type: "array",
        description: "Payments in provider order.",
        items: paymentSchema(),
      },
      nextPageToken: nextPageTokenProperty("payments"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createRefund = defineContract({
  capability: CAPABILITY,
  name: "create_refund",
  description:
    "Refund all or part of a captured payment. This returns funds and is destructive; verify the payment and amount before execution.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_refund",
    direction: "input",
    description: "Payment and optional partial amount to refund.",
    required: ["paymentId"],
    properties: {
      paymentId: id("Provider identifier of the captured payment."),
      amount: {
        type: "integer",
        description:
          "Partial refund amount in the currency's smallest unit; omit for a full refund.",
        minimum: 1,
      },
      reason: {
        type: "string",
        description: "Provider-supported refund reason.",
        enum: ["duplicate", "fraudulent", "requested_by_customer"],
      },
      metadata: metadata("Portable metadata to associate with the refund."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_refund",
    direction: "output",
    description: "The newly created refund.",
    required: [
      "refundId",
      "paymentId",
      "amount",
      "currency",
      "status",
      "createdAt",
    ],
    properties: {
      refundId: id("Provider identifier of the refund."),
      paymentId: id("Provider identifier of the refunded payment."),
      amount: {
        type: "integer",
        description: "Refund amount in the currency's smallest unit.",
        minimum: 0,
      },
      currency: currency(),
      status: { type: "string", description: "Refund state." },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Refund creation timestamp.",
      },
    },
  }),
  annotations: DESTRUCTIVE_CREATE,
  version: VERSION,
});

const createCustomer = defineContract({
  capability: CAPABILITY,
  name: "create_customer",
  description:
    "Create a billing customer for future payments, subscriptions, and invoices.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_customer",
    direction: "input",
    description: "Identity and metadata for a new billing customer.",
    properties: {
      name: {
        type: "string",
        description: "Customer display name.",
        minLength: 1,
      },
      email: {
        type: "string",
        format: "email",
        description: "Customer email address.",
      },
      phone: { type: "string", description: "Customer phone number." },
      metadata: metadata("Portable customer metadata."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_customer",
    direction: "output",
    description: "The newly created billing customer.",
    required: ["customer"],
    properties: { customer: customerSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getCustomer = defineContract({
  capability: CAPABILITY,
  name: "get_customer",
  description: "Retrieve one billing customer and portable payment metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_customer",
    direction: "input",
    description: "Identifier of the billing customer to retrieve.",
    required: ["customerId"],
    properties: {
      customerId: id("Provider identifier of the billing customer."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_customer",
    direction: "output",
    description: "The requested billing customer.",
    required: ["customer"],
    properties: { customer: customerSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const listSubscriptions = defineContract({
  capability: CAPABILITY,
  name: "list_subscriptions",
  description:
    "List subscriptions using customer, status, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_subscriptions",
    direction: "input",
    description: "Subscription filters and pagination.",
    properties: {
      customerId: id("Provider identifier of the billing customer."),
      status: {
        type: "string",
        description: "Subscription state to match.",
        minLength: 1,
      },
      productId: id(
        "Provider product or price identifier to match when supported.",
      ),
      pageSize: pageSizeProperty("subscriptions"),
      pageToken: pageTokenProperty("subscription"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_subscriptions",
    direction: "output",
    description: "One page of normalized subscriptions.",
    required: ["subscriptions"],
    properties: {
      subscriptions: {
        type: "array",
        description: "Subscriptions in provider order.",
        items: subscriptionSchema(),
      },
      nextPageToken: nextPageTokenProperty("subscriptions"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const cancelSubscription = defineContract({
  capability: CAPABILITY,
  name: "cancel_subscription",
  description:
    "Cancel a subscription immediately or at period end. This revokes future service or billing and is destructive; verify the subscription and timing.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "cancel_subscription",
    direction: "input",
    description: "Subscription identifier and cancellation timing.",
    required: ["subscriptionId"],
    properties: {
      subscriptionId: id("Provider identifier of the subscription."),
      atPeriodEnd: {
        type: "boolean",
        description:
          "When true, schedule cancellation for period end instead of canceling immediately.",
        default: false,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "cancel_subscription",
    direction: "output",
    description: "The subscription after applying cancellation.",
    required: ["subscription"],
    properties: { subscription: subscriptionSchema() },
  }),
  annotations: DESTRUCTIVE_UPDATE,
  version: VERSION,
});

function invoiceLineSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "One normalized billing-invoice line.",
    additionalProperties: false,
    required: ["description", "quantity", "unitAmount", "amount"],
    properties: {
      lineId: id("Provider identifier of the invoice line."),
      priceId: id("Provider price identifier for the line."),
      description: { type: "string", description: "Invoice-line description." },
      quantity: {
        type: "integer",
        description: "Billed quantity.",
        minimum: 1,
      },
      unitAmount: {
        type: "integer",
        description: "Unit amount in the currency's smallest unit.",
        minimum: 0,
      },
      amount: {
        type: "integer",
        description: "Extended line amount in the currency's smallest unit.",
        minimum: 0,
      },
    },
  };
}

function invoiceSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized billing invoice.",
    additionalProperties: false,
    required: ["invoiceId", "status", "currency", "amountDue", "createdAt"],
    properties: {
      invoiceId: id("Provider identifier of the billing invoice."),
      customerId: id("Provider identifier of the billed customer."),
      status: { type: "string", description: "Billing-invoice state." },
      currency: currency(),
      amountDue: {
        type: "integer",
        description: "Outstanding amount in the currency's smallest unit.",
        minimum: 0,
      },
      amountPaid: {
        type: "integer",
        description: "Paid amount in the currency's smallest unit.",
        minimum: 0,
      },
      dueAt: {
        type: "string",
        format: "date-time",
        description: "Invoice due timestamp when collection is manual.",
      },
      hostedUrl: {
        type: "string",
        format: "uri",
        description: "Hosted invoice URL when available.",
      },
      lineItems: {
        type: "array",
        description: "Normalized billing-invoice lines.",
        items: invoiceLineSchema(),
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Billing-invoice creation timestamp.",
      },
      finalizedAt: {
        type: "string",
        format: "date-time",
        description: "Timestamp when the invoice was finalized.",
      },
    },
  };
}

const createInvoice = defineContract({
  capability: CAPABILITY,
  name: "create_invoice",
  description:
    "Create a billing invoice with portable line items and collection settings. This creates a customer balance but does not imply successful collection.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_invoice",
    direction: "input",
    description: "Customer, currency, collection settings, and invoice lines.",
    required: ["customerId", "currency", "lineItems"],
    properties: {
      customerId: id("Provider identifier of the billed customer."),
      currency: currency(),
      collectionMethod: {
        type: "string",
        description: "How the invoice should be collected.",
        enum: ["automatic", "send_invoice"],
        default: "automatic",
      },
      dueDays: {
        type: "integer",
        description: "Days until due when collectionMethod is send_invoice.",
        minimum: 1,
      },
      description: {
        type: "string",
        description: "Invoice description or memo.",
      },
      metadata: metadata("Portable metadata to associate with the invoice."),
      lineItems: {
        type: "array",
        description: "One or more billing-invoice lines.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "unitAmount"],
          properties: {
            priceId: id(
              "Provider price identifier when using an existing price.",
            ),
            description: {
              type: "string",
              description: "Invoice-line description.",
              minLength: 1,
            },
            quantity: {
              type: "integer",
              description: "Billed quantity.",
              minimum: 1,
              default: 1,
            },
            unitAmount: {
              type: "integer",
              description: "Unit amount in the currency's smallest unit.",
              minimum: 0,
            },
          },
        },
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_invoice",
    direction: "output",
    description: "The newly created billing invoice.",
    required: ["invoice"],
    properties: { invoice: invoiceSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getInvoice = defineContract({
  capability: CAPABILITY,
  name: "get_invoice",
  description:
    "Retrieve one billing invoice with normalized totals, due state, line items, and hosted references.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_invoice",
    direction: "input",
    description: "Identifier of the billing invoice to retrieve.",
    required: ["invoiceId"],
    properties: {
      invoiceId: id("Provider identifier of the billing invoice."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_invoice",
    direction: "output",
    description: "The requested billing invoice.",
    required: ["invoice"],
    properties: { invoice: invoiceSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const paymentsCapabilityContracts = deepFreeze([
  createPaymentLink,
  getPayment,
  listPayments,
  createRefund,
  createCustomer,
  getCustomer,
  listSubscriptions,
  cancelSubscription,
  createInvoice,
  getInvoice,
] as const satisfies readonly CapabilityToolContract[]);

type PaymentsContract = (typeof paymentsCapabilityContracts)[number];
type PaymentsContractsByName = {
  readonly [Contract in PaymentsContract as Contract["name"]]: Contract;
};

export const paymentsContractsByName = deepFreeze(
  Object.fromEntries(
    paymentsCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as PaymentsContractsByName,
);
