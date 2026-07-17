import { defineCapabilityFixtures } from "../fixtures.js";

export const paymentsFixtures = defineCapabilityFixtures("payments_billing", {
  cancel_subscription: {
    input: (context) => ({
      subscriptionId: context.value("SUBSCRIPTION_ID", "sub_default_000001"),
      atPeriodEnd: false,
    }),
  },
  create_customer: {
    input: {
      name: "Contract Fixture Customer",
      email: "contract-pay@example.com",
    },
  },
  create_invoice: {
    input: (context) => ({
      customerId: context.value("CUSTOMER_ID", "cus_default_000001"),
      currency: "USD",
      lineItems: [
        { description: "Contract fixture line", quantity: 1, unitAmount: 2500 },
      ],
    }),
  },
  create_payment_link: {
    input: { amount: 2500, currency: "USD", description: "Contract fixture" },
  },
  create_refund: {
    input: (context) => ({
      paymentId: context.value("PAYMENT_ID", "ch_default_000001"),
      amount: 500,
      reason: "requested_by_customer",
    }),
  },
  get_customer: {
    input: (context) => ({
      customerId: context.value("CUSTOMER_ID", "cus_default_000001"),
    }),
  },
  get_invoice: {
    input: (context) => ({
      invoiceId: context.value("INVOICE_ID", "in_default_000001"),
    }),
  },
  get_payment: {
    input: (context) => ({
      paymentId: context.value("PAYMENT_ID", "ch_default_000001"),
    }),
  },
  list_payments: { input: { pageSize: 10 } },
  list_subscriptions: { input: { pageSize: 10 } },
});
