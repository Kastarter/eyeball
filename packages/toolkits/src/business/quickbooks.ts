import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  booleanValue,
  finiteNumber,
  idValue,
  inputString,
  jsonObject,
  jsonRequest,
  page,
  parseOffsetToken,
  providerError,
  providerExtension,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

function realmId(context: AdapterContext): string {
  const value = stringValue(providerExtension(context), "realmId");
  if (value === undefined || value.length === 0) {
    throw providerError(
      context,
      "QuickBooks requires x_provider.quickbooks.realmId.",
    );
  }
  return value;
}

function companyPath(context: AdapterContext, path: string): string {
  return `v3/company/${encodeURIComponent(realmId(context))}/${path}`;
}

function referenceId(value: unknown): string | undefined {
  return recordValue({ value }, "value") === undefined
    ? undefined
    : idValue((value as Readonly<Record<string, unknown>>).value);
}

function emailAddress(value: unknown): string | undefined {
  return recordValue({ value }, "value") === undefined
    ? undefined
    : stringValue(value as Readonly<Record<string, unknown>>, "Address");
}

function phoneNumber(value: unknown): string | undefined {
  return recordValue({ value }, "value") === undefined
    ? undefined
    : stringValue(value as Readonly<Record<string, unknown>>, "FreeFormNumber");
}

function billingAddress(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const address = recordValue({ value }, "value");
  if (address === undefined) return undefined;
  const normalized = {
    ...(stringValue(address, "Line1") === undefined
      ? {}
      : { line1: stringValue(address, "Line1") }),
    ...(stringValue(address, "Line2") === undefined
      ? {}
      : { line2: stringValue(address, "Line2") }),
    ...(stringValue(address, "City") === undefined
      ? {}
      : { city: stringValue(address, "City") }),
    ...(stringValue(address, "CountrySubDivisionCode") === undefined
      ? {}
      : { region: stringValue(address, "CountrySubDivisionCode") }),
    ...(stringValue(address, "PostalCode") === undefined
      ? {}
      : { postalCode: stringValue(address, "PostalCode") }),
    ...(stringValue(address, "Country") === undefined
      ? {}
      : { country: stringValue(address, "Country")?.toUpperCase() }),
  };
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function customer(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const email = emailAddress(value.PrimaryEmailAddr);
  const phone = phoneNumber(value.PrimaryPhone);
  const address = billingAddress(value.BillAddr);
  const currency = referenceId(value.CurrencyRef);
  return {
    customerId: requiredId(context, value.Id, "customer"),
    name: requiredString(
      context,
      {
        name:
          stringValue(value, "DisplayName") ??
          stringValue(value, "CompanyName"),
      },
      "name",
    ),
    ...(stringValue(value, "CompanyName") === undefined
      ? {}
      : { companyName: stringValue(value, "CompanyName") }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(currency === undefined ? {} : { currency: currency.toUpperCase() }),
    active: booleanValue(value, "Active") ?? true,
    ...(address === undefined ? {} : { billingAddress: address }),
    properties: value,
  };
}

function invoiceLine(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  index: number,
): Readonly<Record<string, unknown>> {
  const detail = recordValue(value, "SalesItemLineDetail");
  const quantity =
    detail === undefined
      ? 1
      : finiteNumber(context, detail.Qty, "invoice line quantity", 1);
  const amount = finiteNumber(context, value.Amount, "invoice line amount", 0);
  const unitAmount =
    detail === undefined
      ? amount / quantity
      : finiteNumber(
          context,
          detail.UnitPrice,
          "invoice line unit amount",
          amount / quantity,
        );
  const itemId = detail === undefined ? undefined : referenceId(detail.ItemRef);
  return {
    ...(idValue(value.Id) === undefined ? {} : { lineId: idValue(value.Id) }),
    ...(itemId === undefined ? {} : { itemId }),
    description: stringValue(value, "Description") ?? `Line ${index + 1}`,
    quantity,
    unitAmount,
    amount,
  };
}

function invoiceStatus(
  value: Readonly<Record<string, unknown>>,
  balance: number,
): string {
  if (balance === 0) return "paid";
  if (stringValue(value, "EmailStatus") === "EmailSent") return "sent";
  return stringValue(value, "TxnStatus") ?? "draft";
}

function invoice(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const customerId = referenceId(value.CustomerRef);
  if (customerId === undefined) {
    throw providerError(
      context,
      "QuickBooks returned an invoice without a customer reference.",
    );
  }
  const total = finiteNumber(context, value.TotalAmt, "invoice total", 0);
  const balance = finiteNumber(
    context,
    value.Balance,
    "invoice balance",
    total,
  );
  const currency = referenceId(value.CurrencyRef)?.toUpperCase() ?? "USD";
  return {
    invoiceId: requiredId(context, value.Id, "invoice"),
    ...(stringValue(value, "DocNumber") === undefined
      ? {}
      : { number: stringValue(value, "DocNumber") }),
    customerId,
    status: invoiceStatus(value, balance),
    currency,
    total,
    balance,
    ...(stringValue(value, "TxnDate") === undefined
      ? {}
      : { issueDate: stringValue(value, "TxnDate") }),
    ...(stringValue(value, "DueDate") === undefined
      ? {}
      : { dueDate: stringValue(value, "DueDate") }),
    ...(stringValue(value, "SentAt") === undefined
      ? {}
      : { sentAt: stringValue(value, "SentAt") }),
    lineItems: records(value.Line).map((line, index) =>
      invoiceLine(context, line, index),
    ),
    properties: value,
  };
}

function wrapper(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const result = recordValue(value, key);
  if (result === undefined) {
    throw providerError(
      context,
      `QuickBooks omitted the required ${key} response object.`,
    );
  }
  return result;
}

function pageSettings(context: AdapterContext): {
  offset: number;
  pageSize: number;
} {
  return {
    offset: parseOffsetToken(
      context,
      stringValue(context.canonicalInput, "pageToken"),
    ),
    pageSize:
      typeof context.canonicalInput.pageSize === "number"
        ? context.canonicalInput.pageSize
        : 50,
  };
}

async function queryEntities(
  context: AdapterContext,
  entity: "Customer" | "Invoice",
): Promise<Readonly<Record<string, unknown>>[]> {
  const query = encodeURIComponent(`SELECT * FROM ${entity}`);
  const response = await jsonObject(
    context,
    companyPath(context, `query?query=${query}`),
  );
  const queryResponse = recordValue(response, "QueryResponse");
  return queryResponse === undefined ? [] : records(queryResponse[entity]);
}

function addressInput(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const address = recordValue({ value }, "value");
  if (address === undefined) return undefined;
  return {
    ...(stringValue(address, "line1") === undefined
      ? {}
      : { Line1: stringValue(address, "line1") }),
    ...(stringValue(address, "line2") === undefined
      ? {}
      : { Line2: stringValue(address, "line2") }),
    ...(stringValue(address, "city") === undefined
      ? {}
      : { City: stringValue(address, "city") }),
    ...(stringValue(address, "region") === undefined
      ? {}
      : { CountrySubDivisionCode: stringValue(address, "region") }),
    ...(stringValue(address, "postalCode") === undefined
      ? {}
      : { PostalCode: stringValue(address, "postalCode") }),
    ...(stringValue(address, "country") === undefined
      ? {}
      : { Country: stringValue(address, "country") }),
  };
}

export class QuickBooksAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "quickbooks";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "quickbooks.list_customers":
        return this.listCustomers(context);
      case "quickbooks.create_customer":
        return this.createCustomer(context);
      case "quickbooks.list_invoices":
        return this.listInvoices(context);
      case "quickbooks.get_invoice":
        return this.getInvoice(context);
      case "quickbooks.create_invoice":
        return this.createInvoice(context);
      case "quickbooks.send_invoice":
        return this.sendInvoice(context);
      case "quickbooks.record_payment":
        return this.recordPayment(context);
      default:
        return unsupported(context);
    }
  }

  private async listCustomers(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const query = stringValue(input, "query")?.toLowerCase();
    const active = typeof input.active === "boolean" ? input.active : undefined;
    const normalized = (await queryEntities(context, "Customer"))
      .map((value) => customer(context, value))
      .filter((value) => {
        const searchable = [value.name, value.companyName, value.email]
          .filter((item): item is string => typeof item === "string")
          .join(" ")
          .toLowerCase();
        return (
          (query === undefined || searchable.includes(query)) &&
          (active === undefined || value.active === active)
        );
      });
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      customers: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async createCustomer(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const address = addressInput(input.billingAddress);
    const body = await jsonObject(
      context,
      companyPath(context, "customer"),
      jsonRequest({
        ...(recordValue(input, "properties") ?? {}),
        DisplayName: inputString(context, "name"),
        ...(stringValue(input, "companyName") === undefined
          ? {}
          : { CompanyName: stringValue(input, "companyName") }),
        ...(stringValue(input, "email") === undefined
          ? {}
          : { PrimaryEmailAddr: { Address: stringValue(input, "email") } }),
        ...(stringValue(input, "phone") === undefined
          ? {}
          : {
              PrimaryPhone: {
                FreeFormNumber: stringValue(input, "phone"),
              },
            }),
        ...(stringValue(input, "currency") === undefined
          ? {}
          : { CurrencyRef: { value: stringValue(input, "currency") } }),
        ...(address === undefined ? {} : { BillAddr: address }),
      }),
    );
    return asJson({
      customer: customer(context, wrapper(context, body, "Customer")),
    });
  }

  private async listInvoices(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const normalized = (await queryEntities(context, "Invoice"))
      .map((value) => invoice(context, value))
      .filter((value) => {
        const issueDate = stringValue(value, "issueDate");
        return (
          (stringValue(input, "customerId") === undefined ||
            value.customerId === stringValue(input, "customerId")) &&
          (stringValue(input, "status") === undefined ||
            value.status === stringValue(input, "status")) &&
          (stringValue(input, "issuedAfter") === undefined ||
            (issueDate !== undefined &&
              issueDate >= String(input.issuedAfter))) &&
          (stringValue(input, "issuedBefore") === undefined ||
            (issueDate !== undefined && issueDate < String(input.issuedBefore)))
        );
      });
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      invoices: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async getInvoice(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      companyPath(
        context,
        `invoice/${encodeURIComponent(inputString(context, "invoiceId"))}`,
      ),
    );
    return asJson({
      invoice: invoice(context, wrapper(context, body, "Invoice")),
    });
  }

  private async createInvoice(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const lines = records(input.lineItems).map((line) => {
      const quantity = typeof line.quantity === "number" ? line.quantity : 1;
      const unitAmount = finiteNumber(
        context,
        line.unitAmount,
        "invoice line unit amount",
      );
      return {
        Amount: quantity * unitAmount,
        DetailType: "SalesItemLineDetail",
        Description: stringValue(line, "description"),
        SalesItemLineDetail: {
          Qty: quantity,
          UnitPrice: unitAmount,
          ...(stringValue(line, "itemId") === undefined
            ? {}
            : { ItemRef: { value: stringValue(line, "itemId") } }),
        },
      };
    });
    const body = await jsonObject(
      context,
      companyPath(context, "invoice"),
      jsonRequest({
        CustomerRef: { value: inputString(context, "customerId") },
        Line: lines,
        CurrencyRef: {
          value: stringValue(input, "currency") ?? "USD",
        },
        ...(stringValue(input, "issueDate") === undefined
          ? {}
          : { TxnDate: stringValue(input, "issueDate") }),
        ...(stringValue(input, "dueDate") === undefined
          ? {}
          : { DueDate: stringValue(input, "dueDate") }),
        ...(stringValue(input, "memo") === undefined
          ? {}
          : { PrivateNote: stringValue(input, "memo") }),
      }),
    );
    return asJson({
      invoice: invoice(context, wrapper(context, body, "Invoice")),
    });
  }

  private async sendInvoice(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const invoiceId = inputString(context, "invoiceId");
    const email = stringValue(input, "email");
    const suffix =
      email === undefined ? "" : `?sendTo=${encodeURIComponent(email)}`;
    const body = await jsonObject(
      context,
      companyPath(
        context,
        `invoice/${encodeURIComponent(invoiceId)}/send${suffix}`,
      ),
      { method: "POST" },
    );
    const value = wrapper(context, body, "Invoice");
    return asJson({
      invoiceId,
      status: invoiceStatus(
        value,
        finiteNumber(context, value.Balance, "invoice balance", 0),
      ),
      sentAt: stringValue(value, "SentAt") ?? context.clock.now().toISOString(),
    });
  }

  private async recordPayment(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const invoiceId = stringValue(input, "invoiceId");
    let customerId = stringValue(input, "customerId");
    if (customerId === undefined && invoiceId !== undefined) {
      const invoiceBody = await jsonObject(
        context,
        companyPath(context, `invoice/${encodeURIComponent(invoiceId)}`),
      );
      customerId = referenceId(
        wrapper(context, invoiceBody, "Invoice").CustomerRef,
      );
    }
    if (customerId === undefined) {
      throw providerError(
        context,
        "QuickBooks requires a customer for the payment target.",
      );
    }
    const amount = finiteNumber(context, input.amount, "payment amount");
    const currency = stringValue(input, "currency") ?? "USD";
    const body = await jsonObject(
      context,
      companyPath(context, "payment"),
      jsonRequest({
        CustomerRef: { value: customerId },
        TotalAmt: amount,
        CurrencyRef: { value: currency },
        ...(stringValue(input, "paymentDate") === undefined
          ? {}
          : { TxnDate: stringValue(input, "paymentDate") }),
        ...(stringValue(input, "reference") === undefined
          ? {}
          : { PrivateNote: stringValue(input, "reference") }),
        ...(invoiceId === undefined
          ? {}
          : {
              Line: [
                {
                  Amount: amount,
                  LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
                },
              ],
            }),
      }),
    );
    const payment = wrapper(context, body, "Payment");
    const metadata = recordValue(payment, "MetaData");
    return asJson({
      paymentId: requiredId(context, payment.Id, "payment"),
      ...(invoiceId === undefined ? {} : { invoiceId }),
      customerId,
      amount: finiteNumber(context, payment.TotalAmt, "payment amount", amount),
      currency: referenceId(payment.CurrencyRef)?.toUpperCase() ?? currency,
      status: "recorded",
      recordedAt:
        (metadata === undefined
          ? undefined
          : stringValue(metadata, "CreateTime")) ??
        context.clock.now().toISOString(),
    });
  }
}

export const quickBooksAdapter = new QuickBooksAdapter();
