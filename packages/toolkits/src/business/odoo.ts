import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  asJson,
  booleanValue,
  finiteNumber,
  idValue,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  page,
  parseOffsetToken,
  providerError,
  records,
  recordValue,
  requiredId,
  stringArray,
  stringValue,
  unsupported,
} from "./common.js";

const MOVE_FIELDS = [
  "name",
  "move_type",
  "partner_id",
  "amount_total",
  "amount_residual",
  "currency_id",
  "invoice_date",
  "invoice_date_due",
  "state",
  "payment_state",
  "invoice_line_ids",
  "ref",
] as const;

function auth(context: AdapterContext): {
  database: string;
  user: string;
  apiKey: string;
} {
  if (context.credential.type !== "basic") {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "Odoo requires a database, username, and API key.",
    });
  }
  const database = context.credential.parameters?.database;
  if (database === undefined || database.length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "Odoo requires credential parameter database.",
    });
  }
  return {
    database,
    user: context.credential.username,
    apiKey: context.credential.password,
  };
}

async function rpc(
  context: AdapterContext,
  model: string,
  method: string,
  args: readonly unknown[],
  kwargs: Readonly<Record<string, unknown>> = {},
): Promise<unknown> {
  const credential = auth(context);
  const body = await jsonObject(
    context,
    "jsonrpc",
    jsonRequest({
      jsonrpc: "2.0",
      id: "eyeball",
      method: "call",
      params: {
        service: "object",
        method: "execute_kw",
        args: [
          credential.database,
          credential.user,
          credential.apiKey,
          model,
          method,
          args,
          kwargs,
        ],
      },
    }),
  );
  if (isRecord(body.error)) {
    const data = recordValue(body.error, "data");
    const message =
      (data === undefined ? undefined : stringValue(data, "message")) ??
      stringValue(body.error, "message") ??
      "Odoo returned a JSON-RPC fault.";
    const code =
      data === undefined ? idValue(body.error.code) : stringValue(data, "name");
    throw providerError(context, message, {
      ...(code === undefined ? {} : { code }),
      detail: asJson(body.error),
    });
  }
  return body.result;
}

async function searchRead(
  context: AdapterContext,
  model: string,
  domain: readonly unknown[],
  fields: readonly string[],
  offset: number,
  limit: number,
): Promise<Readonly<Record<string, unknown>>[]> {
  const result = await rpc(context, model, "search_read", [domain], {
    fields,
    offset,
    limit,
  });
  if (!Array.isArray(result)) {
    throw providerError(context, "Odoo returned an invalid search result.");
  }
  return records(result);
}

function relationId(value: unknown): string | undefined {
  return Array.isArray(value) ? idValue(value[0]) : idValue(value);
}

function currencyCode(value: unknown): string {
  const raw = Array.isArray(value) ? value[1] : value;
  return typeof raw === "string" && /^[A-Za-z]{3}$/u.test(raw)
    ? raw.toUpperCase()
    : "USD";
}

function customer(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const name = stringValue(value, "name");
  if (name === undefined) {
    throw providerError(context, "Odoo returned a customer without a name.");
  }
  return {
    customerId: requiredId(context, value.id, "customer"),
    name,
    ...(stringValue(value, "company_name") === undefined
      ? {}
      : { companyName: stringValue(value, "company_name") }),
    ...(stringValue(value, "email") === undefined
      ? {}
      : { email: stringValue(value, "email") }),
    ...(stringValue(value, "phone") === undefined
      ? {}
      : { phone: stringValue(value, "phone") }),
    ...(value.currency_id === undefined
      ? {}
      : { currency: currencyCode(value.currency_id) }),
    active: booleanValue(value, "active") ?? true,
    properties: value,
  };
}

function normalizedLines(
  context: AdapterContext,
  value: unknown,
): Readonly<Record<string, unknown>>[] {
  return records(value).map((line, index) => {
    const quantity = finiteNumber(context, line.quantity, "quantity", 1);
    const unitAmount = finiteNumber(
      context,
      line.price_unit ?? line.unitAmount,
      "unit amount",
      finiteNumber(context, line.amount, "amount", 0),
    );
    const amount = finiteNumber(
      context,
      line.price_subtotal ?? line.amount,
      "line amount",
      quantity * unitAmount,
    );
    return {
      ...(idValue(line.id) === undefined ? {} : { lineId: idValue(line.id) }),
      ...(idValue(line.item_id ?? line.itemId) === undefined
        ? {}
        : { itemId: idValue(line.item_id ?? line.itemId) }),
      description:
        stringValue(line, "name") ??
        stringValue(line, "description") ??
        `Line ${index + 1}`,
      quantity,
      unitAmount,
      amount,
      ...(line.tax_amount === undefined
        ? {}
        : {
            taxAmount: finiteNumber(context, line.tax_amount, "tax amount"),
          }),
    };
  });
}

function move(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  kind: "invoice" | "bill",
): Readonly<Record<string, unknown>> {
  const total = finiteNumber(context, value.amount_total, "amount total", 0);
  const balance = finiteNumber(
    context,
    value.amount_residual,
    "amount residual",
    total,
  );
  const partyId = relationId(value.partner_id);
  if (partyId === undefined) {
    throw providerError(
      context,
      `Odoo returned a ${kind} without a partner identifier.`,
    );
  }
  const common = {
    status:
      stringValue(value, "state") ??
      stringValue(value, "payment_state") ??
      "draft",
    currency: currencyCode(value.currency_id),
    total,
    balance,
    ...(stringValue(value, "invoice_date") === undefined
      ? {}
      : { issueDate: stringValue(value, "invoice_date") }),
    ...(stringValue(value, "invoice_date_due") === undefined
      ? {}
      : { dueDate: stringValue(value, "invoice_date_due") }),
    lineItems: normalizedLines(context, value.invoice_line_ids),
    properties: value,
  };
  return kind === "invoice"
    ? {
        invoiceId: requiredId(context, value.id, "invoice"),
        ...(stringValue(value, "name") === undefined
          ? {}
          : { number: stringValue(value, "name") }),
        customerId: partyId,
        ...common,
      }
    : {
        billId: requiredId(context, value.id, "bill"),
        ...(stringValue(value, "name") === undefined
          ? {}
          : { number: stringValue(value, "name") }),
        vendorId: partyId,
        ...common,
      };
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

function nextToken(resultCount: number, offset: number, pageSize: number) {
  return resultCount === pageSize
    ? { nextPageToken: `offset:${offset + resultCount}` }
    : {};
}

function moveDomain(
  context: AdapterContext,
  moveType: "out_invoice" | "in_invoice",
): unknown[] {
  const input = context.canonicalInput;
  const domain: unknown[] = [["move_type", "=", moveType]];
  const party =
    moveType === "out_invoice"
      ? stringValue(input, "customerId")
      : stringValue(input, "vendorId");
  if (party !== undefined) domain.push(["partner_id", "=", party]);
  return domain;
}

function lineValues(value: unknown): Readonly<Record<string, unknown>>[] {
  return records(value).map((line) => {
    const quantity = typeof line.quantity === "number" ? line.quantity : 1;
    const unitAmount =
      typeof line.unitAmount === "number" ? line.unitAmount : 0;
    return {
      name: stringValue(line, "description") ?? "Invoice line",
      quantity,
      price_unit: unitAmount,
      price_subtotal: quantity * unitAmount,
      ...(stringValue(line, "itemId") === undefined
        ? {}
        : { item_id: stringValue(line, "itemId") }),
      ...(stringValue(line, "accountId") === undefined
        ? {}
        : { account_id: stringValue(line, "accountId") }),
      ...(typeof line.taxAmount === "number"
        ? { tax_amount: line.taxAmount }
        : {}),
    };
  });
}

async function createMove(
  context: AdapterContext,
  moveType: "out_invoice" | "in_invoice",
): Promise<Readonly<Record<string, unknown>>> {
  const input = context.canonicalInput;
  const lines = lineValues(input.lineItems);
  const total = lines.reduce(
    (sum, line) =>
      sum + finiteNumber(context, line.price_subtotal, "line total"),
    0,
  );
  const partnerId =
    moveType === "out_invoice"
      ? inputString(context, "customerId")
      : inputString(context, "vendorId");
  const created = await rpc(context, "account.move", "create", [
    {
      move_type: moveType,
      partner_id: partnerId,
      currency_id: stringValue(input, "currency") ?? "USD",
      invoice_date: stringValue(input, "issueDate"),
      invoice_date_due: stringValue(input, "dueDate"),
      ref: stringValue(input, "memo") ?? stringValue(input, "reference"),
      invoice_line_ids: lines,
      amount_total: total,
      amount_residual: total,
    },
  ]);
  const id = idValue(created);
  if (id === undefined) {
    throw providerError(context, "Odoo did not return a created move ID.");
  }
  const found = await searchRead(
    context,
    "account.move",
    [["id", "=", id]],
    MOVE_FIELDS,
    0,
    1,
  );
  const value = found[0];
  if (value === undefined) {
    throw providerError(context, "The created Odoo move could not be read.");
  }
  return value;
}

export class OdooAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "odoo";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "odoo.list_customers":
        return this.listCustomers(context);
      case "odoo.create_customer":
        return this.createCustomer(context);
      case "odoo.list_invoices":
        return this.listMoves(context, "invoice");
      case "odoo.get_invoice":
        return this.getInvoice(context);
      case "odoo.create_invoice":
        return asJson({
          invoice: move(
            context,
            await createMove(context, "out_invoice"),
            "invoice",
          ),
        });
      case "odoo.send_invoice":
        return this.sendInvoice(context);
      case "odoo.list_bills":
        return this.listMoves(context, "bill");
      case "odoo.create_bill":
        return asJson({
          bill: move(context, await createMove(context, "in_invoice"), "bill"),
        });
      case "odoo.search_erp_records":
        return this.searchRecords(context);
      default:
        return unsupported(context);
    }
  }

  private async listCustomers(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const { offset, pageSize } = pageSettings(context);
    const query = stringValue(input, "query")?.toLowerCase();
    const active = booleanValue(input, "active");
    const values = await searchRead(context, "res.partner", [], [], 0, 1_000);
    const normalized = values
      .map((value) => customer(context, value))
      .filter((value) => {
        const searchable = [value.name, value.companyName, value.email]
          .filter((entry): entry is string => typeof entry === "string")
          .join(" ")
          .toLowerCase();
        return (
          (query === undefined || searchable.includes(query)) &&
          (active === undefined || value.active === active)
        );
      });
    const result = page(normalized, offset, pageSize);
    return asJson({
      customers: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async createCustomer(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const properties = recordValue(input, "properties") ?? {};
    const created = await rpc(context, "res.partner", "create", [
      {
        ...properties,
        name: inputString(context, "name"),
        company_name: stringValue(input, "companyName"),
        email: stringValue(input, "email"),
        phone: stringValue(input, "phone"),
        currency_id: stringValue(input, "currency"),
        active: true,
      },
    ]);
    const id = idValue(created);
    if (id === undefined) {
      throw providerError(
        context,
        "Odoo did not return a created customer ID.",
      );
    }
    const found = await searchRead(
      context,
      "res.partner",
      [["id", "=", id]],
      [],
      0,
      1,
    );
    const value = found[0];
    if (value === undefined) {
      throw providerError(
        context,
        "The created Odoo customer could not be read.",
      );
    }
    return asJson({ customer: customer(context, value) });
  }

  private async listMoves(
    context: AdapterContext,
    kind: "invoice" | "bill",
  ): Promise<JsonValue> {
    const { offset, pageSize } = pageSettings(context);
    const input = context.canonicalInput;
    const values = await searchRead(
      context,
      "account.move",
      moveDomain(context, kind === "invoice" ? "out_invoice" : "in_invoice"),
      MOVE_FIELDS,
      0,
      1_000,
    );
    const status = stringValue(input, "status");
    const issuedAfter = stringValue(input, "issuedAfter");
    const issuedBefore = stringValue(input, "issuedBefore");
    const normalized = values
      .map((value) => move(context, value, kind))
      .filter((value) => {
        const issueDate = stringValue(value, "issueDate");
        return (
          (status === undefined || value.status === status) &&
          (issuedAfter === undefined ||
            (issueDate !== undefined && issueDate >= issuedAfter)) &&
          (issuedBefore === undefined ||
            (issueDate !== undefined && issueDate < issuedBefore))
        );
      });
    const result = page(normalized, offset, pageSize);
    const key = kind === "invoice" ? "invoices" : "bills";
    return asJson({
      [key]: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async getInvoice(context: AdapterContext): Promise<JsonValue> {
    const values = await searchRead(
      context,
      "account.move",
      [["id", "=", inputString(context, "invoiceId")]],
      MOVE_FIELDS,
      0,
      1,
    );
    const value = values[0];
    if (value === undefined) {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.NOT_FOUND,
        message: "The requested Odoo invoice was not found.",
        providerDetail: { toolkit: context.tool.toolkit },
      });
    }
    return asJson({ invoice: move(context, value, "invoice") });
  }

  private async sendInvoice(context: AdapterContext): Promise<JsonValue> {
    const invoiceId = inputString(context, "invoiceId");
    const result = await rpc(context, "account.move", "write", [
      [Number.isSafeInteger(Number(invoiceId)) ? Number(invoiceId) : invoiceId],
      { state: "posted" },
    ]);
    if (result !== true) {
      throw providerError(context, "Odoo did not post the invoice.");
    }
    return asJson({
      invoiceId,
      status: "posted",
      sentAt: context.clock.now().toISOString(),
    });
  }

  private async searchRecords(context: AdapterContext): Promise<JsonValue> {
    const model = inputString(context, "model");
    if (model !== "res.partner" && model !== "account.move") {
      return unsupported(
        context,
        "Odoo search_erp_records only supports res.partner and account.move in this adapter.",
      );
    }
    const input = context.canonicalInput;
    const { offset, pageSize } = pageSettings(context);
    const domain = Array.isArray(input.domain) ? input.domain : [];
    const fields = stringArray(input.fields);
    const values = await searchRead(
      context,
      model,
      domain,
      fields,
      offset,
      pageSize,
    );
    return asJson({
      model,
      records: values,
      ...nextToken(values.length, offset, pageSize),
    });
  }
}

export const odooAdapter = new OdooAdapter();
