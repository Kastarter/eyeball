import type {
  CapabilityToolContract,
  JSONSchema202012,
  JSONSchemaObject202012,
} from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "erp_accounting" as const;
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
function id(description: string): JSONSchema202012 {
  return { type: "string", description, minLength: 1 };
}

function currency(): JSONSchemaObject202012 {
  return {
    type: "string",
    description: "ISO 4217 currency code.",
    pattern: "^[A-Z]{3}$",
  };
}

function openProperties(description: string): JSONSchema202012 {
  return {
    type: "object",
    description,
    additionalProperties: true,
  };
}

function addressSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "Portable postal address fields.",
    additionalProperties: false,
    properties: {
      line1: { type: "string", description: "First address line." },
      line2: { type: "string", description: "Second address line." },
      city: { type: "string", description: "City or locality." },
      region: { type: "string", description: "State, province, or region." },
      postalCode: { type: "string", description: "Postal code." },
      country: {
        type: "string",
        description: "ISO 3166-1 alpha-2 country code.",
        pattern: "^[A-Z]{2}$",
      },
    },
  };
}

function customerSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized ERP customer or business partner.",
    additionalProperties: false,
    required: ["customerId", "name"],
    properties: {
      customerId: id("Provider identifier of the customer."),
      name: { type: "string", description: "Customer display name." },
      companyName: {
        type: "string",
        description: "Legal or trading company name.",
      },
      email: {
        type: "string",
        format: "email",
        description: "Customer billing email.",
      },
      phone: { type: "string", description: "Customer phone number." },
      currency: currency(),
      active: {
        type: "boolean",
        description: "Whether the customer is active.",
      },
      billingAddress: addressSchema(),
      properties: openProperties(
        "Additional provider-neutral customer fields.",
      ),
    },
  };
}

function invoiceLineSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "One normalized sales-invoice line.",
    additionalProperties: false,
    required: ["description", "quantity", "unitAmount", "amount"],
    properties: {
      lineId: id("Provider identifier of the invoice line."),
      itemId: id("Provider product, service, or ledger-item identifier."),
      description: { type: "string", description: "Line description." },
      quantity: { type: "number", description: "Billed quantity.", minimum: 0 },
      unitAmount: {
        type: "number",
        description: "Price per unit in major currency units.",
      },
      amount: {
        type: "number",
        description: "Extended line amount in major currency units.",
      },
      taxAmount: {
        type: "number",
        description: "Tax amount for the line in major currency units.",
        minimum: 0,
      },
    },
  };
}

function invoiceSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized sales invoice.",
    additionalProperties: false,
    required: [
      "invoiceId",
      "customerId",
      "status",
      "currency",
      "total",
      "balance",
      "lineItems",
    ],
    properties: {
      invoiceId: id("Provider identifier of the invoice."),
      number: { type: "string", description: "Human-readable invoice number." },
      customerId: id("Provider identifier of the billed customer."),
      status: {
        type: "string",
        description: "Normalized or provider invoice state.",
      },
      currency: currency(),
      total: {
        type: "number",
        description: "Invoice total in major currency units.",
      },
      balance: {
        type: "number",
        description: "Outstanding balance in major currency units.",
      },
      issueDate: {
        type: "string",
        format: "date",
        description: "Invoice issue date.",
      },
      dueDate: {
        type: "string",
        format: "date",
        description: "Invoice due date.",
      },
      sentAt: {
        type: "string",
        format: "date-time",
        description: "Timestamp when the invoice was sent or issued.",
      },
      lineItems: {
        type: "array",
        description: "Normalized sales-invoice lines.",
        items: invoiceLineSchema(),
      },
      properties: openProperties("Additional provider-neutral invoice fields."),
    },
  };
}

const customerInputProperties = {
  name: { type: "string", description: "Customer display name.", minLength: 1 },
  companyName: {
    type: "string",
    description: "Legal or trading company name.",
  },
  email: {
    type: "string",
    format: "email",
    description: "Customer billing email.",
  },
  phone: { type: "string", description: "Customer phone number." },
  currency: currency(),
  billingAddress: addressSchema(),
  properties: openProperties("Additional canonical ERP customer fields."),
} as const;

const listCustomers = defineContract({
  capability: CAPABILITY,
  name: "list_customers",
  description:
    "List ERP customers or business partners using portable text filters and pagination.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_customers",
    direction: "input",
    description: "Customer filters and pagination.",
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive customer name or email query.",
        minLength: 1,
      },
      active: { type: "boolean", description: "Filter by active state." },
      pageSize: pageSizeProperty("customers"),
      pageToken: pageTokenProperty("customer"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_customers",
    direction: "output",
    description: "One page of ERP customers.",
    required: ["customers"],
    properties: {
      customers: {
        type: "array",
        description: "Customer records in provider order.",
        items: customerSchema(),
      },
      nextPageToken: nextPageTokenProperty("customers"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createCustomer = defineContract({
  capability: CAPABILITY,
  name: "create_customer",
  description:
    "Create an ERP customer or business partner. Check for duplicates first when the provider does not enforce unique identities.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_customer",
    direction: "input",
    description: "Identity, billing, and address fields for a new customer.",
    required: ["name"],
    properties: customerInputProperties,
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_customer",
    direction: "output",
    description: "The newly created ERP customer.",
    required: ["customer"],
    properties: { customer: customerSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const listInvoices = defineContract({
  capability: CAPABILITY,
  name: "list_invoices",
  description: "List sales invoices by customer, state, date, and pagination.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_invoices",
    direction: "input",
    description: "Invoice filters and pagination.",
    properties: {
      customerId: id("Provider identifier of the billed customer."),
      status: {
        type: "string",
        description: "Invoice state to match.",
        minLength: 1,
      },
      issuedAfter: {
        type: "string",
        format: "date",
        description: "Return invoices issued on or after this date.",
      },
      issuedBefore: {
        type: "string",
        format: "date",
        description: "Return invoices issued before this date.",
      },
      pageSize: pageSizeProperty("invoices"),
      pageToken: pageTokenProperty("invoice"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_invoices",
    direction: "output",
    description: "One page of normalized sales invoices.",
    required: ["invoices"],
    properties: {
      invoices: {
        type: "array",
        description: "Invoices in provider order.",
        items: invoiceSchema(),
      },
      nextPageToken: nextPageTokenProperty("invoices"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getInvoice = defineContract({
  capability: CAPABILITY,
  name: "get_invoice",
  description:
    "Retrieve one sales invoice with normalized line items, totals, and status.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_invoice",
    direction: "input",
    description: "Identifier of the invoice to retrieve.",
    required: ["invoiceId"],
    properties: { invoiceId: id("Provider identifier of the invoice.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_invoice",
    direction: "output",
    description: "The requested sales invoice.",
    required: ["invoice"],
    properties: { invoice: invoiceSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createInvoice = defineContract({
  capability: CAPABILITY,
  name: "create_invoice",
  description:
    "Create a draft sales invoice with portable line items, currency, dates, and memo fields. This does not send the invoice.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_invoice",
    direction: "input",
    description: "Customer, line items, and terms for a new sales invoice.",
    required: ["customerId", "lineItems"],
    properties: {
      customerId: id("Provider identifier of the billed customer."),
      currency: { ...currency(), default: "USD" },
      issueDate: {
        type: "string",
        format: "date",
        description: "Invoice issue date.",
      },
      dueDate: {
        type: "string",
        format: "date",
        description: "Invoice due date.",
      },
      memo: {
        type: "string",
        description: "Customer-facing or internal invoice memo.",
      },
      lineItems: {
        type: "array",
        description: "One or more sales-invoice lines.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "unitAmount"],
          properties: {
            itemId: id("Provider product, service, or ledger-item identifier."),
            description: {
              type: "string",
              description: "Line description.",
              minLength: 1,
            },
            quantity: {
              type: "number",
              description: "Billed quantity.",
              minimum: 0,
              default: 1,
            },
            unitAmount: {
              type: "number",
              description: "Price per unit in major currency units.",
            },
            taxAmount: {
              type: "number",
              description: "Tax amount for the line in major currency units.",
              minimum: 0,
            },
          },
        },
      },
      properties: openProperties("Additional canonical invoice fields."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_invoice",
    direction: "output",
    description: "The newly created draft sales invoice.",
    required: ["invoice"],
    properties: { invoice: invoiceSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const sendInvoice = defineContract({
  capability: CAPABILITY,
  name: "send_invoice",
  description:
    "Issue or email an existing invoice through the provider workflow. This may notify the customer or post the accounting document.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_invoice",
    direction: "input",
    description: "Invoice identifier and optional delivery address.",
    required: ["invoiceId"],
    properties: {
      invoiceId: id("Provider identifier of the invoice."),
      email: {
        type: "string",
        format: "email",
        description: "Explicit delivery address when the provider supports it.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "send_invoice",
    direction: "output",
    description: "Result of issuing or sending the invoice.",
    required: ["invoiceId", "status", "sentAt"],
    properties: {
      invoiceId: id("Provider identifier of the invoice."),
      status: {
        type: "string",
        description: "Invoice state after the send workflow.",
      },
      sentAt: {
        type: "string",
        format: "date-time",
        description: "Timestamp when the provider completed the workflow.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const recordPayment = defineContract({
  capability: CAPABILITY,
  name: "record_payment",
  description:
    "Record or apply a payment to an invoice or customer account. Verify amount, currency, and target before mutating the ledger.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "record_payment",
      direction: "input",
      description:
        "Invoice or customer target, amount, and reference for a received payment.",
      required: ["amount"],
      properties: {
        invoiceId: id("Provider identifier of the invoice receiving payment."),
        customerId: id(
          "Provider identifier of the customer account receiving payment.",
        ),
        amount: {
          type: "number",
          description: "Payment amount in major currency units.",
          exclusiveMinimum: 0,
        },
        currency: { ...currency(), default: "USD" },
        paymentDate: {
          type: "string",
          format: "date",
          description: "Accounting date for the payment.",
        },
        reference: {
          type: "string",
          description: "External payment reference or memo.",
        },
      },
    }),
    anyOf: [
      {
        required: ["invoiceId"],
        properties: {
          invoiceId: id(
            "Provider identifier of the invoice receiving payment.",
          ),
        },
      },
      {
        required: ["customerId"],
        properties: {
          customerId: id(
            "Provider identifier of the customer account receiving payment.",
          ),
        },
      },
    ],
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "record_payment",
    direction: "output",
    description: "The recorded payment and its application target.",
    required: ["paymentId", "amount", "currency", "status", "recordedAt"],
    properties: {
      paymentId: id("Provider identifier of the payment record."),
      invoiceId: id("Provider identifier of the invoice receiving payment."),
      customerId: id(
        "Provider identifier of the customer account receiving payment.",
      ),
      amount: {
        type: "number",
        description: "Recorded payment amount in major currency units.",
      },
      currency: currency(),
      status: { type: "string", description: "Provider payment state." },
      recordedAt: {
        type: "string",
        format: "date-time",
        description: "Timestamp when the payment was recorded.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

function billSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized vendor bill or accounts-payable document.",
    additionalProperties: false,
    required: [
      "billId",
      "vendorId",
      "status",
      "currency",
      "total",
      "balance",
      "lineItems",
    ],
    properties: {
      billId: id("Provider identifier of the bill."),
      number: {
        type: "string",
        description: "Human-readable vendor bill number.",
      },
      vendorId: id("Provider identifier of the vendor."),
      status: {
        type: "string",
        description: "Normalized or provider bill state.",
      },
      currency: currency(),
      total: {
        type: "number",
        description: "Bill total in major currency units.",
      },
      balance: {
        type: "number",
        description: "Outstanding balance in major currency units.",
      },
      issueDate: {
        type: "string",
        format: "date",
        description: "Bill issue date.",
      },
      dueDate: {
        type: "string",
        format: "date",
        description: "Bill due date.",
      },
      lineItems: {
        type: "array",
        description: "Normalized vendor-bill lines.",
        items: invoiceLineSchema(),
      },
      properties: openProperties("Additional provider-neutral bill fields."),
    },
  };
}

const listBills = defineContract({
  capability: CAPABILITY,
  name: "list_bills",
  description:
    "List vendor bills or accounts-payable documents by vendor, state, date, and pagination.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_bills",
    direction: "input",
    description: "Vendor-bill filters and pagination.",
    properties: {
      vendorId: id("Provider identifier of the vendor."),
      status: {
        type: "string",
        description: "Bill state to match.",
        minLength: 1,
      },
      issuedAfter: {
        type: "string",
        format: "date",
        description: "Return bills issued on or after this date.",
      },
      issuedBefore: {
        type: "string",
        format: "date",
        description: "Return bills issued before this date.",
      },
      pageSize: pageSizeProperty("bills"),
      pageToken: pageTokenProperty("bill"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_bills",
    direction: "output",
    description: "One page of normalized vendor bills.",
    required: ["bills"],
    properties: {
      bills: {
        type: "array",
        description: "Vendor bills in provider order.",
        items: billSchema(),
      },
      nextPageToken: nextPageTokenProperty("bills"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createBill = defineContract({
  capability: CAPABILITY,
  name: "create_bill",
  description:
    "Create a draft vendor bill with portable line items, currency, dates, and memo fields.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_bill",
    direction: "input",
    description: "Vendor, line items, and terms for a new bill.",
    required: ["vendorId", "lineItems"],
    properties: {
      vendorId: id("Provider identifier of the vendor."),
      currency: { ...currency(), default: "USD" },
      issueDate: {
        type: "string",
        format: "date",
        description: "Bill issue date.",
      },
      dueDate: {
        type: "string",
        format: "date",
        description: "Bill due date.",
      },
      reference: { type: "string", description: "Vendor reference or memo." },
      lineItems: {
        type: "array",
        description: "One or more vendor-bill lines.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "unitAmount"],
          properties: {
            accountId: id("Provider expense or ledger-account identifier."),
            itemId: id("Provider product or service identifier."),
            description: {
              type: "string",
              description: "Line description.",
              minLength: 1,
            },
            quantity: {
              type: "number",
              description: "Billed quantity.",
              minimum: 0,
              default: 1,
            },
            unitAmount: {
              type: "number",
              description: "Price per unit in major currency units.",
            },
            taxAmount: {
              type: "number",
              description: "Tax amount in major currency units.",
              minimum: 0,
            },
          },
        },
      },
      properties: openProperties("Additional canonical bill fields."),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_bill",
    direction: "output",
    description: "The newly created draft vendor bill.",
    required: ["bill"],
    properties: { bill: billSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const listAccounts = defineContract({
  capability: CAPABILITY,
  name: "list_accounts",
  description:
    "List chart-of-account or ledger accounts with portable type, status, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_accounts",
    direction: "input",
    description: "Ledger-account filters and pagination.",
    properties: {
      type: {
        type: "string",
        description: "Account type or classification to match.",
        minLength: 1,
      },
      active: { type: "boolean", description: "Filter by active state." },
      pageSize: pageSizeProperty("accounts"),
      pageToken: pageTokenProperty("account"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_accounts",
    direction: "output",
    description: "One page of normalized ledger accounts.",
    required: ["accounts"],
    properties: {
      accounts: {
        type: "array",
        description: "Ledger accounts in provider order.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "name", "type", "active"],
          properties: {
            accountId: id("Provider identifier of the ledger account."),
            name: { type: "string", description: "Ledger-account name." },
            code: { type: "string", description: "Account number or code." },
            type: {
              type: "string",
              description: "Account type or classification.",
            },
            currency: currency(),
            active: {
              type: "boolean",
              description: "Whether the account is active.",
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("accounts"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createJournalEntry = defineContract({
  capability: CAPABILITY,
  name: "create_journal_entry",
  description:
    "Create a balanced general-ledger journal entry. Verify every account, debit, credit, and accounting date before posting.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_journal_entry",
    direction: "input",
    description: "Accounting date, currency, memo, and balanced journal lines.",
    required: ["lines"],
    properties: {
      accountingDate: {
        type: "string",
        format: "date",
        description: "Accounting date for the journal entry.",
      },
      currency: { ...currency(), default: "USD" },
      memo: { type: "string", description: "Journal-entry memo or reference." },
      lines: {
        type: "array",
        description:
          "Two or more debit or credit lines whose totals must balance.",
        minItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "description", "debit", "credit"],
          properties: {
            accountId: id("Provider identifier of the ledger account."),
            description: {
              type: "string",
              description: "Journal-line description.",
              minLength: 1,
            },
            debit: {
              type: "number",
              description: "Debit amount in major currency units.",
              minimum: 0,
            },
            credit: {
              type: "number",
              description: "Credit amount in major currency units.",
              minimum: 0,
            },
          },
        },
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_journal_entry",
    direction: "output",
    description: "The created balanced journal entry.",
    required: ["journalEntryId", "status", "currency", "lines", "createdAt"],
    properties: {
      journalEntryId: id("Provider identifier of the journal entry."),
      status: { type: "string", description: "Journal-entry state." },
      currency: currency(),
      accountingDate: {
        type: "string",
        format: "date",
        description: "Accounting date of the journal entry.",
      },
      memo: { type: "string", description: "Journal-entry memo or reference." },
      lines: {
        type: "array",
        description: "Normalized journal lines.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["accountId", "description", "debit", "credit"],
          properties: {
            accountId: id("Provider identifier of the ledger account."),
            description: {
              type: "string",
              description: "Journal-line description.",
            },
            debit: {
              type: "number",
              description: "Debit amount in major currency units.",
            },
            credit: {
              type: "number",
              description: "Credit amount in major currency units.",
            },
          },
        },
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Journal-entry creation timestamp.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const searchErpRecords = defineContract({
  capability: CAPABILITY,
  name: "search_erp_records",
  description:
    "Search a provider-supported ERP model with a structured domain and selected fields. Model availability is restricted by each provider adapter.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_erp_records",
    direction: "input",
    description:
      "ERP model, provider domain expression, fields, and pagination.",
    required: ["model", "domain"],
    properties: {
      model: {
        type: "string",
        description: "Provider model or accounting object name.",
        minLength: 1,
      },
      domain: {
        type: "array",
        description:
          "Provider domain expression passed through after model allowlist validation.",
        items: true,
      },
      fields: {
        type: "array",
        description: "Fields to return when the provider supports projection.",
        items: { type: "string", minLength: 1 },
      },
      pageSize: pageSizeProperty("ERP records"),
      pageToken: pageTokenProperty("ERP record"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_erp_records",
    direction: "output",
    description: "One page of provider records from the selected ERP model.",
    required: ["model", "records"],
    properties: {
      model: { type: "string", description: "Provider model searched." },
      records: {
        type: "array",
        description: "Matching ERP records.",
        items: openProperties("One provider ERP record."),
      },
      nextPageToken: nextPageTokenProperty("ERP records"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const erpCapabilityContracts = deepFreeze([
  listCustomers,
  createCustomer,
  listInvoices,
  getInvoice,
  createInvoice,
  sendInvoice,
  recordPayment,
  listBills,
  createBill,
  listAccounts,
  createJournalEntry,
  searchErpRecords,
] as const satisfies readonly CapabilityToolContract[]);

type ErpContract = (typeof erpCapabilityContracts)[number];
type ErpContractsByName = {
  readonly [Contract in ErpContract as Contract["name"]]: Contract;
};

export const erpContractsByName = deepFreeze(
  Object.fromEntries(
    erpCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as ErpContractsByName,
);
