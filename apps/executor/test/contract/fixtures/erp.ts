import { defineCapabilityFixtures } from "../fixtures.js";

function quickBooksExtension(
  provider: string,
): Readonly<Record<string, unknown>> {
  return provider === "quickbooks"
    ? { x_provider: { quickbooks: { realmId: "realm_fixture" } } }
    : {};
}

function customerId(provider: string): string {
  return provider === "quickbooks"
    ? "quickbooks_customer_default_000001"
    : "101";
}

function invoiceId(provider: string): string {
  return provider === "quickbooks"
    ? "quickbooks_invoice_default_000001"
    : "201";
}

export const erpFixtures = defineCapabilityFixtures("erp_accounting", {
  create_bill: {
    input: {
      vendorId: "102",
      currency: "USD",
      lineItems: [{ description: "Contract fixture supplies", unitAmount: 45 }],
    },
  },
  create_customer: {
    input: (context) => ({
      name: "Contract Fixture Customer",
      email: "contract-books@example.com",
      ...quickBooksExtension(context.provider),
    }),
  },
  create_invoice: {
    input: (context) => ({
      customerId: context.value("CUSTOMER_ID", customerId(context.provider)),
      currency: "USD",
      lineItems: [
        {
          description: "Contract fixture service",
          quantity: 2,
          unitAmount: 75,
        },
      ],
      ...quickBooksExtension(context.provider),
    }),
  },
  create_journal_entry: {
    input: {
      currency: "USD",
      lines: [
        { accountId: "account-1", debit: 10, credit: 0 },
        { accountId: "account-2", debit: 0, credit: 10 },
      ],
    },
  },
  get_invoice: {
    input: (context) => ({
      invoiceId: context.value("INVOICE_ID", invoiceId(context.provider)),
      ...quickBooksExtension(context.provider),
    }),
  },
  list_accounts: { input: { pageSize: 10 } },
  list_bills: { input: { pageSize: 10 } },
  list_customers: {
    input: (context) => ({
      pageSize: 10,
      ...quickBooksExtension(context.provider),
    }),
  },
  list_invoices: {
    input: (context) => ({
      pageSize: 10,
      ...quickBooksExtension(context.provider),
    }),
  },
  record_payment: {
    input: (context) => ({
      invoiceId: context.value("INVOICE_ID", invoiceId(context.provider)),
      amount: 50,
      currency: "USD",
      ...quickBooksExtension(context.provider),
    }),
  },
  search_erp_records: {
    input: {
      model: "res.partner",
      domain: [["name", "ilike", "Corp"]],
      fields: ["name", "email"],
    },
  },
  send_invoice: {
    input: (context) => ({
      invoiceId: context.value("INVOICE_ID", invoiceId(context.provider)),
      email: "contract-books@example.com",
      ...quickBooksExtension(context.provider),
    }),
  },
});
