import { defineCapabilityFixtures } from "../fixtures.js";

export const ecommerceFixtures = defineCapabilityFixtures("ecommerce", {
  create_fulfillment: {
    input: (context) => ({
      orderId: context.value("ORDER_ID", "6001"),
      lineItems: [
        { lineItemId: context.value("LINE_ITEM_ID", "7001"), quantity: 1 },
      ],
      trackingCompany: "Contract Carrier",
      trackingNumber: "CONTRACT-TRACK-1",
    }),
  },
  create_product: {
    input: {
      title: "Contract Fixture Product",
      status: "draft",
      variants: [
        {
          title: "Default Title",
          price: 12.5,
          sku: "CONTRACT-SKU-1",
          inventoryQuantity: 3,
        },
      ],
    },
  },
  get_order: {
    input: (context) => ({ orderId: context.value("ORDER_ID", "6001") }),
  },
  get_product: {
    input: (context) => ({ productId: context.value("PRODUCT_ID", "1001") }),
  },
  list_customers: { input: { query: "Avery", pageSize: 10 } },
  list_orders: { input: { pageSize: 10 } },
  list_products: { input: { pageSize: 10 } },
  update_inventory: {
    input: (context) => ({
      inventoryItemId: context.value("INVENTORY_ITEM_ID", "3001"),
      locationId: context.value("LOCATION_ID", "4001"),
      quantity: 11,
    }),
  },
  update_order: {
    input: (context) => ({
      orderId: context.value("ORDER_ID", "6001"),
      note: "Updated by the contract fixture.",
    }),
  },
  update_product: {
    input: (context) => ({
      productId: context.value("PRODUCT_ID", "1001"),
      title: "Contract Fixture Product Updated",
    }),
  },
});
