import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "ecommerce" as const;
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
const UPDATE = {
  readOnly: false,
  destructive: false,
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

function stringList(description: string): JSONSchema202012 {
  return {
    type: "array",
    description,
    items: { type: "string", minLength: 1 },
  };
}

function variantSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized product variant.",
    additionalProperties: false,
    required: [
      "variantId",
      "title",
      "price",
      "inventoryItemId",
      "inventoryQuantity",
    ],
    properties: {
      variantId: id("Provider identifier of the variant."),
      title: { type: "string", description: "Variant title." },
      price: {
        type: "number",
        description: "Variant price in major currency units.",
        minimum: 0,
      },
      sku: { type: "string", description: "Merchant stock-keeping unit." },
      inventoryItemId: id("Provider inventory-item identifier."),
      inventoryQuantity: {
        type: "integer",
        description: "Current inventory quantity reported by the product API.",
      },
    },
  };
}

function productSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized e-commerce product.",
    additionalProperties: false,
    required: [
      "productId",
      "title",
      "status",
      "tags",
      "variants",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      productId: id("Provider identifier of the product."),
      title: { type: "string", description: "Product title." },
      descriptionHtml: {
        type: "string",
        description: "Product description serialized as HTML.",
      },
      vendor: { type: "string", description: "Product vendor or brand." },
      productType: {
        type: "string",
        description: "Merchant product classification.",
      },
      handle: { type: "string", description: "Storefront handle or slug." },
      status: { type: "string", description: "Product publication state." },
      tags: stringList("Product tags."),
      variants: {
        type: "array",
        description: "Product variants.",
        items: variantSchema(),
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Product creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent product update timestamp.",
      },
    },
  };
}

function orderLineSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "One normalized order line.",
    additionalProperties: false,
    required: ["lineItemId", "title", "quantity", "unitPrice"],
    properties: {
      lineItemId: id("Provider identifier of the order line."),
      productId: id("Provider identifier of the product."),
      variantId: id("Provider identifier of the product variant."),
      title: { type: "string", description: "Purchased item title." },
      quantity: {
        type: "integer",
        description: "Purchased quantity.",
        minimum: 0,
      },
      unitPrice: {
        type: "number",
        description: "Price per item in major currency units.",
        minimum: 0,
      },
    },
  };
}

function orderSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized e-commerce order.",
    additionalProperties: false,
    required: [
      "orderId",
      "name",
      "financialStatus",
      "fulfillmentStatus",
      "lineItems",
      "total",
      "currency",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      orderId: id("Provider identifier of the order."),
      name: {
        type: "string",
        description: "Human-readable order number or name.",
      },
      email: {
        type: "string",
        format: "email",
        description: "Customer email address.",
      },
      customerId: id("Provider identifier of the store customer."),
      financialStatus: { type: "string", description: "Order payment state." },
      fulfillmentStatus: {
        type: ["string", "null"],
        description: "Order fulfillment state, or null when unfulfilled.",
      },
      lineItems: {
        type: "array",
        description: "Purchased order lines.",
        items: orderLineSchema(),
      },
      total: {
        type: "number",
        description: "Order total in major currency units.",
        minimum: 0,
      },
      currency: currency(),
      note: {
        type: ["string", "null"],
        description: "Merchant or customer order note.",
      },
      tags: stringList("Order tags."),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Order creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent order update timestamp.",
      },
    },
  };
}

function customerSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized e-commerce customer.",
    additionalProperties: false,
    required: [
      "customerId",
      "firstName",
      "lastName",
      "email",
      "ordersCount",
      "totalSpent",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      customerId: id("Provider identifier of the store customer."),
      firstName: { type: "string", description: "Customer given name." },
      lastName: { type: "string", description: "Customer family name." },
      email: {
        type: "string",
        format: "email",
        description: "Customer email address.",
      },
      phone: { type: "string", description: "Customer phone number." },
      ordersCount: {
        type: "integer",
        description: "Number of orders attributed to the customer.",
        minimum: 0,
      },
      totalSpent: {
        type: "number",
        description: "Lifetime spend in major currency units.",
        minimum: 0,
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Customer creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent customer update timestamp.",
      },
    },
  };
}

const listProducts = defineContract({
  capability: CAPABILITY,
  name: "list_products",
  description:
    "List products using publication status and pagination filters, including normalized variants and inventory metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_products",
    direction: "input",
    description: "Product filters and pagination.",
    properties: {
      status: {
        type: "string",
        description: "Product publication state to match.",
        minLength: 1,
      },
      collectionId: id("Provider collection identifier when supported."),
      pageSize: pageSizeProperty("products"),
      pageToken: pageTokenProperty("product"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_products",
    direction: "output",
    description: "One page of normalized products.",
    required: ["products"],
    properties: {
      products: {
        type: "array",
        description: "Products in provider order.",
        items: productSchema(),
      },
      nextPageToken: nextPageTokenProperty("products"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getProduct = defineContract({
  capability: CAPABILITY,
  name: "get_product",
  description:
    "Retrieve one product with normalized variants, pricing, and inventory metadata.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_product",
    direction: "input",
    description: "Identifier of the product to retrieve.",
    required: ["productId"],
    properties: { productId: id("Provider identifier of the product.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_product",
    direction: "output",
    description: "The requested normalized product.",
    required: ["product"],
    properties: { product: productSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const createProduct = defineContract({
  capability: CAPABILITY,
  name: "create_product",
  description:
    "Create a product and its initial variants. This changes the store catalog; verify publication status, pricing, and inventory before execution.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_product",
    direction: "input",
    description: "Product content and initial variants.",
    required: ["title"],
    properties: {
      title: { type: "string", description: "Product title.", minLength: 1 },
      descriptionHtml: {
        type: "string",
        description: "Product description serialized as HTML.",
      },
      vendor: { type: "string", description: "Product vendor or brand." },
      productType: {
        type: "string",
        description: "Merchant product classification.",
      },
      handle: {
        type: "string",
        description: "Storefront handle or slug.",
        minLength: 1,
      },
      status: {
        type: "string",
        description: "Initial publication state.",
        enum: ["active", "draft", "archived"],
        default: "draft",
      },
      tags: stringList("Initial product tags."),
      variants: {
        type: "array",
        description:
          "Initial product variants; the provider creates a default variant when omitted.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", description: "Variant title." },
            price: {
              type: "number",
              description: "Variant price in major currency units.",
              minimum: 0,
            },
            sku: {
              type: "string",
              description: "Merchant stock-keeping unit.",
            },
            inventoryQuantity: {
              type: "integer",
              description: "Initial inventory quantity.",
              default: 0,
            },
          },
        },
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_product",
    direction: "output",
    description: "The newly created product.",
    required: ["product"],
    properties: { product: productSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const updateProduct = defineContract({
  capability: CAPABILITY,
  name: "update_product",
  description:
    "Update product content, pricing metadata, tags, or publication state. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_product",
      direction: "input",
      description: "Product identifier and fields to update.",
      required: ["productId"],
      properties: {
        productId: id("Provider identifier of the product."),
        title: { type: "string", description: "Updated product title." },
        descriptionHtml: {
          type: "string",
          description: "Updated product description serialized as HTML.",
        },
        vendor: { type: "string", description: "Updated vendor or brand." },
        productType: {
          type: "string",
          description: "Updated merchant product classification.",
        },
        status: {
          type: "string",
          description: "Updated publication state.",
          enum: ["active", "draft", "archived"],
        },
        tags: stringList("Replacement product tags."),
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_product",
    direction: "output",
    description: "The updated product.",
    required: ["product"],
    properties: { product: productSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const updateInventory = defineContract({
  capability: CAPABILITY,
  name: "update_inventory",
  description:
    "Set inventory for a product variant at a location. This overwrites the available quantity, so verify the target item, location, and count.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_inventory",
    direction: "input",
    description: "Inventory item, location, and absolute available quantity.",
    required: ["inventoryItemId", "locationId", "quantity"],
    properties: {
      inventoryItemId: id("Provider inventory-item identifier."),
      locationId: id("Provider inventory-location identifier."),
      quantity: {
        type: "integer",
        description: "Absolute available quantity to set.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_inventory",
    direction: "output",
    description: "The resulting inventory level.",
    required: ["inventoryItemId", "locationId", "quantity", "updatedAt"],
    properties: {
      inventoryItemId: id("Provider inventory-item identifier."),
      locationId: id("Provider inventory-location identifier."),
      quantity: {
        type: "integer",
        description: "Available quantity after the update.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Inventory update timestamp.",
      },
    },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const listOrders = defineContract({
  capability: CAPABILITY,
  name: "list_orders",
  description:
    "List orders using customer, payment, fulfillment, time, and pagination filters.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_orders",
    direction: "input",
    description: "Order filters and pagination.",
    properties: {
      customerId: id("Provider identifier of the store customer."),
      financialStatus: {
        type: "string",
        description: "Order payment state to match.",
        minLength: 1,
      },
      fulfillmentStatus: {
        type: "string",
        description: "Fulfillment state to match.",
        minLength: 1,
      },
      createdAfter: {
        type: "string",
        format: "date-time",
        description: "Return orders created at or after this timestamp.",
      },
      createdBefore: {
        type: "string",
        format: "date-time",
        description: "Return orders created before this timestamp.",
      },
      pageSize: pageSizeProperty("orders"),
      pageToken: pageTokenProperty("order"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_orders",
    direction: "output",
    description: "One page of normalized orders.",
    required: ["orders"],
    properties: {
      orders: {
        type: "array",
        description: "Orders in provider order.",
        items: orderSchema(),
      },
      nextPageToken: nextPageTokenProperty("orders"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const getOrder = defineContract({
  capability: CAPABILITY,
  name: "get_order",
  description:
    "Retrieve one order with normalized line items, customer, totals, and fulfillment state.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_order",
    direction: "input",
    description: "Identifier of the order to retrieve.",
    required: ["orderId"],
    properties: { orderId: id("Provider identifier of the order.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_order",
    direction: "output",
    description: "The requested normalized order.",
    required: ["order"],
    properties: { order: orderSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateOrder = defineContract({
  capability: CAPABILITY,
  name: "update_order",
  description:
    "Update provider-supported order fields, payment or fulfillment state, note, and tags. Verify state transitions before execution.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_order",
      direction: "input",
      description: "Order identifier and fields to update.",
      required: ["orderId"],
      properties: {
        orderId: id("Provider identifier of the order."),
        email: {
          type: "string",
          format: "email",
          description: "Updated customer email address.",
        },
        financialStatus: {
          type: "string",
          description: "Updated payment state.",
        },
        fulfillmentStatus: {
          type: ["string", "null"],
          description: "Updated fulfillment state, or null when unfulfilled.",
        },
        note: {
          type: ["string", "null"],
          description: "Updated merchant or customer order note.",
        },
        tags: stringList("Replacement order tags."),
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_order",
    direction: "output",
    description: "The updated order.",
    required: ["order"],
    properties: { order: orderSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const createFulfillment = defineContract({
  capability: CAPABILITY,
  name: "create_fulfillment",
  description:
    "Create a fulfillment or shipment for an order. This can notify customers and change fulfillment state; verify items and tracking first.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_fulfillment",
    direction: "input",
    description: "Order, fulfilled items, and tracking details.",
    required: ["orderId"],
    properties: {
      orderId: id("Provider identifier of the order."),
      lineItems: {
        type: "array",
        description:
          "Specific order lines to fulfill; omit to fulfill all remaining items.",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["lineItemId", "quantity"],
          properties: {
            lineItemId: id("Provider identifier of the order line."),
            quantity: {
              type: "integer",
              description: "Quantity to fulfill.",
              minimum: 1,
            },
          },
        },
      },
      trackingCompany: { type: "string", description: "Carrier name." },
      trackingNumber: {
        type: "string",
        description: "Carrier tracking number.",
      },
      trackingUrl: {
        type: "string",
        format: "uri",
        description: "Carrier tracking URL when supported.",
      },
      notifyCustomer: {
        type: "boolean",
        description: "Whether the provider should notify the customer.",
        default: false,
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_fulfillment",
    direction: "output",
    description: "The newly created fulfillment.",
    required: ["fulfillmentId", "orderId", "status", "lineItems", "createdAt"],
    properties: {
      fulfillmentId: id("Provider identifier of the fulfillment."),
      orderId: id("Provider identifier of the fulfilled order."),
      status: { type: "string", description: "Fulfillment state." },
      trackingCompany: { type: "string", description: "Carrier name." },
      trackingNumber: {
        type: "string",
        description: "Carrier tracking number.",
      },
      lineItems: {
        type: "array",
        description: "Provider fulfillment line records.",
        items: { type: "object", additionalProperties: true },
      },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Fulfillment creation timestamp.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

const listCustomers = defineContract({
  capability: CAPABILITY,
  name: "list_customers",
  description:
    "List store customers using identity, time, and pagination filters with normalized order and spend summaries.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_customers",
    direction: "input",
    description: "Customer identity filters and pagination.",
    properties: {
      query: {
        type: "string",
        description: "Case-insensitive customer name or email query.",
        minLength: 1,
      },
      createdAfter: {
        type: "string",
        format: "date-time",
        description: "Return customers created at or after this timestamp.",
      },
      createdBefore: {
        type: "string",
        format: "date-time",
        description: "Return customers created before this timestamp.",
      },
      pageSize: pageSizeProperty("customers"),
      pageToken: pageTokenProperty("customer"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_customers",
    direction: "output",
    description: "One page of normalized store customers.",
    required: ["customers"],
    properties: {
      customers: {
        type: "array",
        description: "Customers in provider order.",
        items: customerSchema(),
      },
      nextPageToken: nextPageTokenProperty("customers"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

export const ecommerceCapabilityContracts = deepFreeze([
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  updateInventory,
  listOrders,
  getOrder,
  updateOrder,
  createFulfillment,
  listCustomers,
] as const satisfies readonly CapabilityToolContract[]);

type EcommerceContract = (typeof ecommerceCapabilityContracts)[number];
type EcommerceContractsByName = {
  readonly [Contract in EcommerceContract as Contract["name"]]: Contract;
};

export const ecommerceContractsByName = deepFreeze(
  Object.fromEntries(
    ecommerceCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as EcommerceContractsByName,
);
