import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  booleanValue,
  finiteNumber,
  formRequest,
  inputString,
  isoFromUnix,
  jsonObject,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

function metadataValues(value: unknown): Readonly<Record<string, string>> {
  const metadata = recordValue({ value }, "value");
  if (metadata === undefined) return {};
  return Object.fromEntries(
    Object.entries(metadata).map(([key, entry]) => [
      `metadata[${key}]`,
      entry === null ? "" : String(entry),
    ]),
  );
}

function paymentLink(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    paymentLinkId: requiredId(context, value.id, "payment link"),
    url: requiredString(context, value, "url"),
    status: booleanValue(value, "active") === false ? "inactive" : "active",
    amount: finiteNumber(context, value.amount_total, "payment-link amount"),
    currency: requiredString(context, value, "currency").toUpperCase(),
    createdAt: isoFromUnix(context, value.created, "created"),
  };
}

function payment(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    paymentId: requiredId(context, value.id, "payment"),
    amount: finiteNumber(context, value.amount, "payment amount"),
    currency: requiredString(context, value, "currency").toUpperCase(),
    status: requiredString(context, value, "status"),
    ...(typeof value.customer === "string"
      ? { customerId: value.customer }
      : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    captured:
      booleanValue(value, "paid") ??
      finiteNumber(context, value.amount_captured, "captured amount", 0) > 0,
    createdAt: isoFromUnix(context, value.created, "created"),
  };
}

function customer(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    customerId: requiredId(context, value.id, "customer"),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.phone === "string" ? { phone: value.phone } : {}),
    metadata: recordValue(value, "metadata") ?? {},
    createdAt: isoFromUnix(context, value.created, "created"),
  };
}

function subscription(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    subscriptionId: requiredId(context, value.id, "subscription"),
    customerId: requiredId(context, value.customer, "customer"),
    status: requiredString(context, value, "status"),
    cancelAtPeriodEnd: booleanValue(value, "cancel_at_period_end") ?? false,
    ...(value.canceled_at === null || value.canceled_at === undefined
      ? {}
      : { canceledAt: isoFromUnix(context, value.canceled_at, "canceled_at") }),
    createdAt: isoFromUnix(context, value.created, "created"),
  };
}

function invoice(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    invoiceId: requiredId(context, value.id, "invoice"),
    ...(typeof value.customer === "string"
      ? { customerId: value.customer }
      : {}),
    status: requiredString(context, value, "status"),
    currency: requiredString(context, value, "currency").toUpperCase(),
    amountDue: finiteNumber(context, value.amount_due, "invoice amount due"),
    ...(value.amount_paid === undefined
      ? {}
      : {
          amountPaid: finiteNumber(
            context,
            value.amount_paid,
            "invoice amount paid",
          ),
        }),
    ...(typeof value.hosted_invoice_url === "string"
      ? { hostedUrl: value.hosted_invoice_url }
      : {}),
    createdAt: isoFromUnix(context, value.created, "created"),
    ...(value.finalized_at === null || value.finalized_at === undefined
      ? {}
      : {
          finalizedAt: isoFromUnix(context, value.finalized_at, "finalized_at"),
        }),
  };
}

function listData(
  context: AdapterContext,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(body.data)) {
    throw providerError(
      context,
      "Stripe returned a list without a data array.",
    );
  }
  return records(body.data);
}

function nextPageToken(
  body: Readonly<Record<string, unknown>>,
  values: readonly Readonly<Record<string, unknown>>[],
): string | undefined {
  return booleanValue(body, "has_more") === true
    ? requiredListId(values.at(-1))
    : undefined;
}

function requiredListId(
  value: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return value === undefined ? undefined : idValueForList(value.id);
}

function idValueForList(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function listSearch(context: AdapterContext): URLSearchParams {
  const input = context.canonicalInput;
  const search = new URLSearchParams({
    limit: String(typeof input.pageSize === "number" ? input.pageSize : 50),
  });
  const pageToken = stringValue(input, "pageToken");
  if (pageToken !== undefined) search.set("starting_after", pageToken);
  return search;
}

export class StripeAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "stripe";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "stripe.create_payment_link":
        return this.createPaymentLink(context);
      case "stripe.get_payment":
        return this.getPayment(context);
      case "stripe.list_payments":
        return this.listPayments(context);
      case "stripe.create_refund":
        return this.createRefund(context);
      case "stripe.create_customer":
        return this.createCustomer(context);
      case "stripe.get_customer":
        return this.getCustomer(context);
      case "stripe.list_subscriptions":
        return this.listSubscriptions(context);
      case "stripe.cancel_subscription":
        return this.cancelSubscription(context);
      case "stripe.create_invoice":
        return this.createInvoice(context);
      case "stripe.get_invoice":
        return this.getInvoice(context);
      default:
        return unsupported(context);
    }
  }

  private async createPaymentLink(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const amount = String(input.amount);
    const currency = inputString(context, "currency").toLowerCase();
    const description = stringValue(input, "description") ?? "Payment";
    const values: Record<string, string> = {
      "line_items[0][price_data][currency]": currency,
      "line_items[0][price_data][unit_amount]": amount,
      "line_items[0][price_data][product_data][name]": description,
      "line_items[0][quantity]": "1",
      ...metadataValues(input.metadata),
    };
    const customerId = stringValue(input, "customerId");
    if (customerId !== undefined) values["metadata[customer_id]"] = customerId;
    const body = await jsonObject(
      context,
      "v1/payment_links",
      formRequest(values),
    );
    return asJson(paymentLink(context, body));
  }

  private async getPayment(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `v1/charges/${encodeURIComponent(inputString(context, "paymentId"))}`,
    );
    return asJson({ payment: payment(context, body) });
  }

  private async listPayments(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = listSearch(context);
    const customerId = stringValue(input, "customerId");
    const status = stringValue(input, "status");
    if (customerId !== undefined) search.set("customer", customerId);
    if (status !== undefined) search.set("status", status);
    const body = await jsonObject(context, `v1/charges?${search.toString()}`);
    const raw = listData(context, body);
    const createdAfter = stringValue(input, "createdAfter");
    const createdBefore = stringValue(input, "createdBefore");
    const normalized = raw
      .map((value) => payment(context, value))
      .filter((value) => {
        const createdAt = String(value.createdAt);
        return (
          (createdAfter === undefined || createdAt >= createdAfter) &&
          (createdBefore === undefined || createdAt < createdBefore)
        );
      });
    const token = nextPageToken(body, raw);
    return asJson({
      payments: normalized,
      ...(token === undefined ? {} : { nextPageToken: token }),
    });
  }

  private async createRefund(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const paymentId = inputString(context, "paymentId");
    const values: Record<string, string> = {
      charge: paymentId,
      ...metadataValues(input.metadata),
    };
    if (typeof input.amount === "number") values.amount = String(input.amount);
    const reason = stringValue(input, "reason");
    if (reason !== undefined) values.reason = reason;
    const body = await jsonObject(context, "v1/refunds", formRequest(values));
    return asJson({
      refundId: requiredId(context, body.id, "refund"),
      paymentId: requiredId(context, body.charge, "payment"),
      amount: finiteNumber(context, body.amount, "refund amount"),
      currency: requiredString(context, body, "currency").toUpperCase(),
      status: requiredString(context, body, "status"),
      createdAt: isoFromUnix(context, body.created, "created"),
    });
  }

  private async createCustomer(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const values: Record<string, string> = {
      ...metadataValues(input.metadata),
    };
    for (const key of ["name", "email", "phone"] as const) {
      const value = stringValue(input, key);
      if (value !== undefined) values[key] = value;
    }
    const body = await jsonObject(context, "v1/customers", formRequest(values));
    return asJson({ customer: customer(context, body) });
  }

  private async getCustomer(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `v1/customers/${encodeURIComponent(inputString(context, "customerId"))}`,
    );
    return asJson({ customer: customer(context, body) });
  }

  private async listSubscriptions(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    if (stringValue(input, "productId") !== undefined) {
      return unsupported(
        context,
        "The Stripe mock surface does not expose subscription product expansion.",
      );
    }
    const search = listSearch(context);
    const customerId = stringValue(input, "customerId");
    const status = stringValue(input, "status");
    if (customerId !== undefined) search.set("customer", customerId);
    if (status !== undefined) search.set("status", status);
    const body = await jsonObject(
      context,
      `v1/subscriptions?${search.toString()}`,
    );
    const raw = listData(context, body);
    const token = nextPageToken(body, raw);
    return asJson({
      subscriptions: raw.map((value) => subscription(context, value)),
      ...(token === undefined ? {} : { nextPageToken: token }),
    });
  }

  private async cancelSubscription(
    context: AdapterContext,
  ): Promise<JsonValue> {
    if (context.canonicalInput.atPeriodEnd === true) {
      return unsupported(
        context,
        "The current Stripe mock supports immediate cancellation only.",
      );
    }
    const body = await jsonObject(
      context,
      `v1/subscriptions/${encodeURIComponent(inputString(context, "subscriptionId"))}`,
      formRequest({}, "DELETE"),
    );
    return asJson({ subscription: subscription(context, body) });
  }

  private async createInvoice(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const amount = records(input.lineItems).reduce((sum, line) => {
      const quantity = typeof line.quantity === "number" ? line.quantity : 1;
      return (
        sum +
        quantity * finiteNumber(context, line.unitAmount, "invoice unit amount")
      );
    }, 0);
    const body = await jsonObject(
      context,
      "v1/invoices",
      formRequest({
        customer: inputString(context, "customerId"),
        currency: inputString(context, "currency").toLowerCase(),
        amount: String(amount),
        ...(stringValue(input, "description") === undefined
          ? {}
          : { description: stringValue(input, "description") as string }),
        ...metadataValues(input.metadata),
      }),
    );
    return asJson({ invoice: invoice(context, body) });
  }

  private async getInvoice(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `v1/invoices/${encodeURIComponent(inputString(context, "invoiceId"))}`,
    );
    return asJson({ invoice: invoice(context, body) });
  }
}

export const stripeAdapter = new StripeAdapter();
