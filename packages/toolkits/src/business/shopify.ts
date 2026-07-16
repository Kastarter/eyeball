import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import {
  asJson,
  finiteNumber,
  inputString,
  isoString,
  jsonObject,
  jsonRequest,
  page,
  parseOffsetToken,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringArray,
  stringValue,
  unsupported,
} from "./common.js";

const API_ROOT = "admin/api/2024-01";

function request(
  context: AdapterContext,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): RequestInit {
  if (context.credential.type !== "oauth2") {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "Shopify requires an OAuth access token.",
    });
  }
  const init = jsonRequest(body, method);
  return {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      "X-Shopify-Access-Token": context.credential.accessToken,
    },
  };
}

function tags(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value);
  return typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
}

function variant(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    variantId: requiredId(context, value.id, "variant"),
    title: requiredString(context, value, "title"),
    price: finiteNumber(context, value.price, "variant price"),
    ...(typeof value.sku === "string" ? { sku: value.sku } : {}),
    inventoryItemId: requiredId(
      context,
      value.inventory_item_id,
      "inventory item",
    ),
    inventoryQuantity: finiteNumber(
      context,
      value.inventory_quantity,
      "inventory quantity",
      0,
    ),
  };
}

function product(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    productId: requiredId(context, value.id, "product"),
    title: requiredString(context, value, "title"),
    ...(typeof value.body_html === "string"
      ? { descriptionHtml: value.body_html }
      : {}),
    ...(typeof value.vendor === "string" ? { vendor: value.vendor } : {}),
    ...(typeof value.product_type === "string"
      ? { productType: value.product_type }
      : {}),
    ...(typeof value.handle === "string" ? { handle: value.handle } : {}),
    status: requiredString(context, value, "status"),
    tags: tags(value.tags),
    variants: records(value.variants).map((entry) => variant(context, entry)),
    createdAt: isoString(context, value.created_at, "created_at"),
    updatedAt: isoString(context, value.updated_at, "updated_at"),
  };
}

function orderLine(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    lineItemId: requiredId(context, value.id, "line item"),
    ...(value.product_id === null || value.product_id === undefined
      ? {}
      : { productId: requiredId(context, value.product_id, "product") }),
    ...(value.variant_id === null || value.variant_id === undefined
      ? {}
      : { variantId: requiredId(context, value.variant_id, "variant") }),
    title: requiredString(context, value, "title"),
    quantity: finiteNumber(context, value.quantity, "line-item quantity"),
    unitPrice: finiteNumber(context, value.price, "line-item price"),
  };
}

function order(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const customer = recordValue(value, "customer");
  return {
    orderId: requiredId(context, value.id, "order"),
    name: requiredString(context, value, "name"),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(customer === undefined || customer.id === undefined
      ? {}
      : { customerId: requiredId(context, customer.id, "customer") }),
    financialStatus: requiredString(context, value, "financial_status"),
    fulfillmentStatus:
      value.fulfillment_status === null
        ? null
        : requiredString(context, value, "fulfillment_status"),
    lineItems: records(value.line_items).map((entry) =>
      orderLine(context, entry),
    ),
    total: finiteNumber(context, value.total_price, "order total"),
    currency: requiredString(context, value, "currency").toUpperCase(),
    note: typeof value.note === "string" ? value.note : null,
    tags: tags(value.tags),
    createdAt: isoString(context, value.created_at, "created_at"),
    updatedAt: isoString(context, value.updated_at, "updated_at"),
  };
}

function customer(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    customerId: requiredId(context, value.id, "customer"),
    firstName: requiredString(context, value, "first_name"),
    lastName: requiredString(context, value, "last_name"),
    email: requiredString(context, value, "email"),
    ...(typeof value.phone === "string" ? { phone: value.phone } : {}),
    ordersCount: finiteNumber(context, value.orders_count, "orders count", 0),
    totalSpent: finiteNumber(context, value.total_spent, "total spent", 0),
    createdAt: isoString(context, value.created_at, "created_at"),
    updatedAt: isoString(context, value.updated_at, "updated_at"),
  };
}

function wrapped(
  context: AdapterContext,
  body: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = recordValue(body, key);
  if (value === undefined) {
    throw providerError(
      context,
      `Shopify omitted the required ${key} response object.`,
    );
  }
  return value;
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

function productInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    ...(stringValue(input, "title") === undefined
      ? {}
      : { title: stringValue(input, "title") }),
    ...(stringValue(input, "descriptionHtml") === undefined
      ? {}
      : { body_html: stringValue(input, "descriptionHtml") }),
    ...(stringValue(input, "vendor") === undefined
      ? {}
      : { vendor: stringValue(input, "vendor") }),
    ...(stringValue(input, "productType") === undefined
      ? {}
      : { product_type: stringValue(input, "productType") }),
    ...(stringValue(input, "handle") === undefined
      ? {}
      : { handle: stringValue(input, "handle") }),
    ...(stringValue(input, "status") === undefined
      ? {}
      : { status: stringValue(input, "status") }),
    ...(input.tags === undefined ? {} : { tags: tags(input.tags).join(",") }),
  };
}

export class ShopifyAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "shopify";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "shopify.list_products":
        return this.listProducts(context);
      case "shopify.get_product":
        return this.getProduct(context);
      case "shopify.create_product":
        return this.createProduct(context);
      case "shopify.update_product":
        return this.updateProduct(context);
      case "shopify.update_inventory":
        return this.updateInventory(context);
      case "shopify.list_orders":
        return this.listOrders(context);
      case "shopify.get_order":
        return this.getOrder(context);
      case "shopify.update_order":
        return this.updateOrder(context);
      case "shopify.create_fulfillment":
        return this.createFulfillment(context);
      case "shopify.list_customers":
        return this.listCustomers(context);
      default:
        return unsupported(context);
    }
  }

  private async listProducts(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    if (stringValue(input, "collectionId") !== undefined) {
      return unsupported(
        context,
        "The Shopify mock surface does not expose collection membership.",
      );
    }
    const search = new URLSearchParams({ limit: "250" });
    const status = stringValue(input, "status");
    if (status !== undefined) search.set("status", status);
    const body = await jsonObject(
      context,
      `${API_ROOT}/products.json?${search.toString()}`,
    );
    const normalized = records(body.products).map((entry) =>
      product(context, entry),
    );
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      products: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async getProduct(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `${API_ROOT}/products/${encodeURIComponent(inputString(context, "productId"))}.json`,
    );
    return asJson({
      product: product(context, wrapped(context, body, "product")),
    });
  }

  private async createProduct(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const variants = records(input.variants).map((entry) => ({
      ...(stringValue(entry, "title") === undefined
        ? {}
        : { title: stringValue(entry, "title") }),
      ...(typeof entry.price === "number"
        ? { price: String(entry.price) }
        : {}),
      ...(stringValue(entry, "sku") === undefined
        ? {}
        : { sku: stringValue(entry, "sku") }),
      ...(typeof entry.inventoryQuantity === "number"
        ? { inventory_quantity: entry.inventoryQuantity }
        : {}),
    }));
    const body = await jsonObject(
      context,
      `${API_ROOT}/products.json`,
      request(context, {
        product: {
          ...productInput(input),
          title: inputString(context, "title"),
          ...(variants.length === 0 ? {} : { variants }),
        },
      }),
    );
    return asJson({
      product: product(context, wrapped(context, body, "product")),
    });
  }

  private async updateProduct(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/products/${encodeURIComponent(inputString(context, "productId"))}.json`,
      request(context, { product: productInput(input) }, "PUT"),
    );
    return asJson({
      product: product(context, wrapped(context, body, "product")),
    });
  }

  private async updateInventory(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/inventory_levels/set.json`,
      request(context, {
        inventory_item_id: inputString(context, "inventoryItemId"),
        location_id: inputString(context, "locationId"),
        available: input.quantity,
      }),
    );
    const level = wrapped(context, body, "inventory_level");
    return asJson({
      inventoryItemId: requiredId(
        context,
        level.inventory_item_id,
        "inventory item",
      ),
      locationId: requiredId(context, level.location_id, "location"),
      quantity: finiteNumber(context, level.available, "inventory quantity"),
      updatedAt: isoString(context, level.updated_at, "updated_at"),
    });
  }

  private async listOrders(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({ limit: "250" });
    const financialStatus = stringValue(input, "financialStatus");
    if (financialStatus !== undefined) {
      search.set("financial_status", financialStatus);
    }
    const body = await jsonObject(
      context,
      `${API_ROOT}/orders.json?${search.toString()}`,
    );
    const customerId = stringValue(input, "customerId");
    const fulfillmentStatus = stringValue(input, "fulfillmentStatus");
    const createdAfter = stringValue(input, "createdAfter");
    const createdBefore = stringValue(input, "createdBefore");
    const normalized = records(body.orders)
      .map((entry) => order(context, entry))
      .filter((entry) => {
        const createdAt = String(entry.createdAt);
        return (
          (customerId === undefined || entry.customerId === customerId) &&
          (fulfillmentStatus === undefined ||
            entry.fulfillmentStatus === fulfillmentStatus) &&
          (createdAfter === undefined || createdAt >= createdAfter) &&
          (createdBefore === undefined || createdAt < createdBefore)
        );
      });
    const settings = pageSettings(context);
    const result = page(normalized, settings.offset, settings.pageSize);
    return asJson({
      orders: result.values,
      ...(result.nextPageToken === undefined
        ? {}
        : { nextPageToken: result.nextPageToken }),
    });
  }

  private async getOrder(context: AdapterContext): Promise<JsonValue> {
    const body = await jsonObject(
      context,
      `${API_ROOT}/orders/${encodeURIComponent(inputString(context, "orderId"))}.json`,
    );
    return asJson({ order: order(context, wrapped(context, body, "order")) });
  }

  private async updateOrder(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/orders/${encodeURIComponent(inputString(context, "orderId"))}.json`,
      request(
        context,
        {
          order: {
            ...(stringValue(input, "email") === undefined
              ? {}
              : { email: stringValue(input, "email") }),
            ...(stringValue(input, "financialStatus") === undefined
              ? {}
              : { financial_status: stringValue(input, "financialStatus") }),
            ...(input.fulfillmentStatus === undefined
              ? {}
              : { fulfillment_status: input.fulfillmentStatus }),
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.tags === undefined
              ? {}
              : { tags: tags(input.tags).join(",") }),
          },
        },
        "PUT",
      ),
    );
    return asJson({ order: order(context, wrapped(context, body, "order")) });
  }

  private async createFulfillment(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const body = await jsonObject(
      context,
      `${API_ROOT}/fulfillments.json`,
      request(context, {
        fulfillment: {
          order_id: inputString(context, "orderId"),
          ...(Array.isArray(input.lineItems)
            ? {
                line_items: records(input.lineItems).map((entry) => ({
                  id: requiredId(context, entry.lineItemId, "line item"),
                  quantity: entry.quantity,
                })),
              }
            : {}),
          ...(stringValue(input, "trackingCompany") === undefined
            ? {}
            : { tracking_company: stringValue(input, "trackingCompany") }),
          ...(stringValue(input, "trackingNumber") === undefined
            ? {}
            : { tracking_number: stringValue(input, "trackingNumber") }),
          ...(stringValue(input, "trackingUrl") === undefined
            ? {}
            : { tracking_url: stringValue(input, "trackingUrl") }),
          notify_customer: input.notifyCustomer === true,
        },
      }),
    );
    const value = wrapped(context, body, "fulfillment");
    return asJson({
      fulfillmentId: requiredId(context, value.id, "fulfillment"),
      orderId: requiredId(context, value.order_id, "order"),
      status: requiredString(context, value, "status"),
      ...(typeof value.tracking_company === "string"
        ? { trackingCompany: value.tracking_company }
        : {}),
      ...(typeof value.tracking_number === "string"
        ? { trackingNumber: value.tracking_number }
        : {}),
      lineItems: records(value.line_items),
      createdAt: isoString(context, value.created_at, "created_at"),
    });
  }

  private async listCustomers(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams({ limit: "250" });
    const query = stringValue(input, "query");
    if (query !== undefined) search.set("query", query);
    const body = await jsonObject(
      context,
      `${API_ROOT}/customers.json?${search.toString()}`,
    );
    const createdAfter = stringValue(input, "createdAfter");
    const createdBefore = stringValue(input, "createdBefore");
    const normalized = records(body.customers)
      .map((entry) => customer(context, entry))
      .filter((entry) => {
        const createdAt = String(entry.createdAt);
        return (
          (createdAfter === undefined || createdAt >= createdAfter) &&
          (createdBefore === undefined || createdAt < createdBefore)
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
}

export const shopifyAdapter = new ShopifyAdapter();
