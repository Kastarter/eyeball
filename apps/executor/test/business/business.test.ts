import { describe, expect, it } from "vitest";
import {
  createHubSpotMock,
  createOdooMock,
  createQuickBooksMock,
  createShopifyMock,
  createStripeMock,
  createZendeskMock,
  hubSpotFixtures,
  odooFixtures,
  quickBooksFixtures,
  STRIPE_CARD_DECLINE_AMOUNT,
  shopifyFixtures,
  stripeFixtures,
  zendeskFixtures,
} from "../../../../mocks/packages/mocks-business/dist/index.js";
import { createBusinessMockHarness, executionOutput } from "./helpers.js";

describe("P0 business adapters", () => {
  it("creates, searches, updates, and annotates HubSpot CRM records", async () => {
    const provider = createHubSpotMock();
    await provider.seed(hubSpotFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "oauth2",
      accessToken: "fixture:valid",
    });

    const searched = executionOutput(
      await harness.execute("hubspot.search_contacts", {
        email: "avery@acme.example",
      }),
    );
    expect(searched.contacts).toEqual([
      expect.objectContaining({
        contactId: "hubspot_contact_default_000001",
        firstName: "Avery",
        email: "avery@acme.example",
      }),
    ]);

    const createdContact = executionOutput(
      await harness.execute("hubspot.create_contact", {
        email: "casey@fixtures.example",
        firstName: "Casey",
        lastName: "Fixture",
      }),
    ).contact as Readonly<Record<string, unknown>>;
    const contactId = String(createdContact.contactId);
    expect(createdContact).toMatchObject({
      email: "casey@fixtures.example",
      firstName: "Casey",
      lastName: "Fixture",
    });

    expect(
      executionOutput(
        await harness.execute("hubspot.update_contact", {
          contactId,
          phone: "+15550001099",
        }),
      ).contact,
    ).toMatchObject({ contactId, phone: "+15550001099" });
    expect(
      executionOutput(
        await harness.execute("hubspot.get_contact", { contactId }),
      ).contact,
    ).toMatchObject({ contactId, email: "casey@fixtures.example" });

    const createdCompany = executionOutput(
      await harness.execute("hubspot.create_company", {
        name: "Fixture Labs",
        domain: "fixtures.example",
      }),
    ).company as Readonly<Record<string, unknown>>;
    const companyId = String(createdCompany.companyId);
    expect(
      executionOutput(
        await harness.execute("hubspot.update_company", {
          companyId,
          phone: "+15550002099",
        }),
      ).company,
    ).toMatchObject({ companyId, phone: "+15550002099" });

    const createdDeal = executionOutput(
      await harness.execute("hubspot.create_deal", {
        name: "Fixture rollout",
        amount: 4200,
        stage: "appointmentscheduled",
        pipeline: "default",
      }),
    ).deal as Readonly<Record<string, unknown>>;
    const dealId = String(createdDeal.dealId);
    expect(
      executionOutput(
        await harness.execute("hubspot.update_deal", {
          dealId,
          stage: "qualifiedtobuy",
        }),
      ).deal,
    ).toMatchObject({ dealId, stage: "qualifiedtobuy" });

    expect(
      executionOutput(
        await harness.execute("hubspot.add_note", {
          recordType: "contact",
          recordId: contactId,
          body: "Canonical CRM note from the deterministic fixture.",
        }),
      ),
    ).toMatchObject({
      noteId: expect.any(String),
      recordType: "contact",
      recordId: contactId,
      body: "Canonical CRM note from the deterministic fixture.",
    });
  });

  it("runs customer, invoice, bill, and model-search flows through Odoo", async () => {
    const provider = createOdooMock();
    await provider.seed(odooFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "basic",
      username: "fixture-user",
      password: "fixture:valid",
      parameters: { database: "fixture-db" },
    });

    const customers = executionOutput(
      await harness.execute("odoo.list_customers", { query: "Acme" }),
    );
    expect(customers.customers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ customerId: "101", name: "Acme Corp" }),
        expect.objectContaining({ customerId: "102", name: "Acme Supplies" }),
      ]),
    );

    const createdCustomer = executionOutput(
      await harness.execute("odoo.create_customer", {
        name: "Fixture Customer",
        email: "billing@fixtures.example",
        currency: "USD",
      }),
    ).customer as Readonly<Record<string, unknown>>;
    expect(createdCustomer).toMatchObject({
      customerId: expect.any(String),
      name: "Fixture Customer",
      email: "billing@fixtures.example",
    });

    expect(
      executionOutput(
        await harness.execute("odoo.get_invoice", { invoiceId: "201" }),
      ).invoice,
    ).toMatchObject({
      invoiceId: "201",
      customerId: "101",
      number: "INV/2026/0001",
      total: 1250,
    });
    expect(
      executionOutput(
        await harness.execute("odoo.list_invoices", { status: "posted" }),
      ).invoices,
    ).toEqual([expect.objectContaining({ invoiceId: "201" })]);

    const createdInvoice = executionOutput(
      await harness.execute("odoo.create_invoice", {
        customerId: "101",
        currency: "USD",
        lineItems: [
          {
            description: "Fixture implementation",
            quantity: 2,
            unitAmount: 75,
          },
        ],
      }),
    ).invoice as Readonly<Record<string, unknown>>;
    const invoiceId = String(createdInvoice.invoiceId);
    expect(createdInvoice).toMatchObject({
      customerId: "101",
      status: "draft",
      total: 150,
    });
    expect(
      executionOutput(
        await harness.execute("odoo.send_invoice", { invoiceId }),
      ),
    ).toMatchObject({ invoiceId, status: "posted" });

    expect(
      executionOutput(await harness.execute("odoo.list_bills", {})).bills,
    ).toEqual([expect.objectContaining({ billId: "202", vendorId: "102" })]);
    expect(
      executionOutput(
        await harness.execute("odoo.create_bill", {
          vendorId: "102",
          currency: "USD",
          lineItems: [{ description: "Fixture supplies", unitAmount: 45 }],
        }),
      ).bill,
    ).toMatchObject({ vendorId: "102", total: 45, status: "draft" });

    expect(
      executionOutput(
        await harness.execute("odoo.search_erp_records", {
          model: "res.partner",
          domain: [["name", "ilike", "Corp"]],
          fields: ["name", "email"],
        }),
      ),
    ).toMatchObject({
      model: "res.partner",
      records: [expect.objectContaining({ id: 101, name: "Acme Corp" })],
    });
  });

  it("runs customer, invoice, send, and payment flows through QuickBooks", async () => {
    const provider = createQuickBooksMock();
    await provider.seed(quickBooksFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "oauth2",
      accessToken: "fixture:valid",
    });
    const realm = { x_provider: { quickbooks: { realmId: "realm_fixture" } } };

    expect(
      executionOutput(
        await harness.execute("quickbooks.list_customers", {
          ...realm,
          query: "Retail",
        }),
      ).customers,
    ).toEqual([
      expect.objectContaining({
        customerId: "quickbooks_customer_default_000002",
        name: "Acme Retail",
      }),
    ]);

    const createdCustomer = executionOutput(
      await harness.execute("quickbooks.create_customer", {
        ...realm,
        name: "Fixture Books Customer",
        email: "books@fixtures.example",
      }),
    ).customer as Readonly<Record<string, unknown>>;
    const customerId = String(createdCustomer.customerId);
    expect(createdCustomer).toMatchObject({
      name: "Fixture Books Customer",
      email: "books@fixtures.example",
    });

    expect(
      executionOutput(
        await harness.execute("quickbooks.get_invoice", {
          ...realm,
          invoiceId: "quickbooks_invoice_default_000001",
        }),
      ).invoice,
    ).toMatchObject({
      invoiceId: "quickbooks_invoice_default_000001",
      customerId: "quickbooks_customer_default_000001",
      total: 1250,
    });

    const createdInvoice = executionOutput(
      await harness.execute("quickbooks.create_invoice", {
        ...realm,
        customerId,
        currency: "USD",
        lineItems: [
          { description: "Fixture accounting", quantity: 2, unitAmount: 90 },
        ],
      }),
    ).invoice as Readonly<Record<string, unknown>>;
    const invoiceId = String(createdInvoice.invoiceId);
    expect(createdInvoice).toMatchObject({
      customerId,
      status: "draft",
      total: 180,
      balance: 180,
    });

    expect(
      executionOutput(
        await harness.execute("quickbooks.send_invoice", {
          ...realm,
          invoiceId,
          email: "books@fixtures.example",
        }),
      ),
    ).toMatchObject({ invoiceId, status: "sent" });

    expect(
      executionOutput(
        await harness.execute("quickbooks.record_payment", {
          ...realm,
          invoiceId,
          amount: 90,
          currency: "USD",
        }),
      ),
    ).toMatchObject({
      paymentId: expect.any(String),
      invoiceId,
      customerId,
      amount: 90,
      currency: "USD",
      status: "recorded",
    });
  });

  it("runs payment, refund, customer, subscription, and invoice flows through Stripe", async () => {
    const provider = createStripeMock();
    await provider.seed(stripeFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "api_key",
      values: { apiKey: "fixture:valid" },
    });

    expect(
      executionOutput(
        await harness.execute("stripe.get_payment", {
          paymentId: "ch_default_000001",
        }),
      ).payment,
    ).toMatchObject({
      paymentId: "ch_default_000001",
      amount: 12_500,
      currency: "USD",
      status: "succeeded",
      captured: true,
    });
    expect(
      executionOutput(
        await harness.execute("stripe.list_payments", {
          customerId: "cus_default_000001",
          pageSize: 1,
        }),
      ),
    ).toMatchObject({
      payments: [expect.objectContaining({ customerId: "cus_default_000001" })],
      nextPageToken: expect.any(String),
    });

    expect(
      executionOutput(
        await harness.execute("stripe.create_payment_link", {
          amount: 4200,
          currency: "USD",
          description: "Fixture checkout",
        }),
      ),
    ).toMatchObject({
      paymentLinkId: expect.any(String),
      url: expect.stringContaining("checkout.stripe.example"),
      amount: 4200,
      currency: "USD",
      status: "active",
    });

    const createdCustomer = executionOutput(
      await harness.execute("stripe.create_customer", {
        name: "Fixture Billing Customer",
        email: "billing@fixtures.example",
        metadata: { source: "business-adapter-test" },
      }),
    ).customer as Readonly<Record<string, unknown>>;
    const customerId = String(createdCustomer.customerId);
    expect(
      executionOutput(
        await harness.execute("stripe.get_customer", { customerId }),
      ).customer,
    ).toMatchObject({
      customerId,
      name: "Fixture Billing Customer",
    });

    expect(
      executionOutput(
        await harness.execute("stripe.create_refund", {
          paymentId: "ch_default_000001",
          amount: 2500,
          reason: "requested_by_customer",
        }),
      ),
    ).toMatchObject({
      refundId: expect.any(String),
      paymentId: "ch_default_000001",
      amount: 2500,
      currency: "USD",
      status: "succeeded",
    });

    expect(
      executionOutput(
        await harness.execute("stripe.list_subscriptions", {
          customerId: "cus_default_000001",
        }),
      ).subscriptions,
    ).toEqual([
      expect.objectContaining({
        subscriptionId: "sub_default_000001",
        status: "active",
      }),
    ]);
    expect(
      executionOutput(
        await harness.execute("stripe.cancel_subscription", {
          subscriptionId: "sub_default_000001",
        }),
      ).subscription,
    ).toMatchObject({
      subscriptionId: "sub_default_000001",
      status: "canceled",
      cancelAtPeriodEnd: false,
      canceledAt: expect.any(String),
    });

    const createdInvoice = executionOutput(
      await harness.execute("stripe.create_invoice", {
        customerId,
        currency: "USD",
        lineItems: [
          {
            description: "Fixture billing line",
            quantity: 2,
            unitAmount: 1600,
          },
        ],
      }),
    ).invoice as Readonly<Record<string, unknown>>;
    const invoiceId = String(createdInvoice.invoiceId);
    expect(createdInvoice).toMatchObject({
      customerId,
      amountDue: 3200,
      currency: "USD",
      status: "draft",
    });
    expect(
      executionOutput(
        await harness.execute("stripe.get_invoice", { invoiceId }),
      ).invoice,
    ).toMatchObject({ invoiceId, customerId, amountDue: 3200 });
  });

  it("preserves Stripe decline diagnostics without exposing secrets", async () => {
    const harness = createBusinessMockHarness(createStripeMock(), {
      type: "api_key",
      values: { apiKey: "fixture:valid" },
    });
    const result = await harness.execute("stripe.create_payment_link", {
      amount: STRIPE_CARD_DECLINE_AMOUNT,
      currency: "USD",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "failed",
      error: {
        code: "provider_error",
        provider: {
          toolkit: "stripe",
          status: 402,
          detail: {
            error: {
              type: "card_error",
              code: "card_declined",
              message: expect.stringContaining("declined"),
            },
          },
        },
      },
    });
  });

  it("runs product, inventory, order, fulfillment, and customer flows through Shopify", async () => {
    const provider = createShopifyMock();
    await provider.seed(shopifyFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "oauth2",
      accessToken: "fixture:valid",
    });

    expect(
      executionOutput(
        await harness.execute("shopify.list_products", { status: "active" }),
      ).products,
    ).toEqual([
      expect.objectContaining({
        productId: "1001",
        title: "Acme Fixture T-Shirt",
        status: "active",
      }),
    ]);
    expect(
      executionOutput(
        await harness.execute("shopify.get_product", { productId: "1001" }),
      ).product,
    ).toMatchObject({ productId: "1001", variants: [expect.any(Object)] });

    const createdProduct = executionOutput(
      await harness.execute("shopify.create_product", {
        title: "Fixture Notebook",
        status: "draft",
        tags: ["fixture", "stationery"],
        variants: [
          {
            title: "Default Title",
            price: 12.5,
            sku: "FIX-NOTE-001",
            inventoryQuantity: 7,
          },
        ],
      }),
    ).product as Readonly<Record<string, unknown>>;
    const productId = String(createdProduct.productId);
    const variants = createdProduct.variants as Readonly<
      Readonly<Record<string, unknown>>[]
    >;
    const inventoryItemId = String(variants[0]?.inventoryItemId);
    expect(createdProduct).toMatchObject({
      productId: expect.any(String),
      title: "Fixture Notebook",
      status: "draft",
    });

    expect(
      executionOutput(
        await harness.execute("shopify.update_product", {
          productId,
          status: "active",
          tags: ["fixture", "published"],
        }),
      ).product,
    ).toMatchObject({
      productId,
      status: "active",
      tags: ["fixture", "published"],
    });
    expect(
      executionOutput(
        await harness.execute("shopify.update_inventory", {
          inventoryItemId,
          locationId: "4001",
          quantity: 11,
        }),
      ),
    ).toMatchObject({ inventoryItemId, locationId: "4001", quantity: 11 });

    expect(
      executionOutput(
        await harness.execute("shopify.list_orders", {
          customerId: "5001",
        }),
      ).orders,
    ).toEqual([expect.objectContaining({ orderId: "6001", total: 50 })]);
    expect(
      executionOutput(
        await harness.execute("shopify.get_order", { orderId: "6001" }),
      ).order,
    ).toMatchObject({ orderId: "6001", fulfillmentStatus: null });
    expect(
      executionOutput(
        await harness.execute("shopify.update_order", {
          orderId: "6001",
          note: "Prepared by the deterministic fixture.",
          tags: ["fixture", "ready"],
        }),
      ).order,
    ).toMatchObject({
      orderId: "6001",
      note: "Prepared by the deterministic fixture.",
      tags: ["fixture", "ready"],
    });

    expect(
      executionOutput(
        await harness.execute("shopify.create_fulfillment", {
          orderId: "6001",
          lineItems: [{ lineItemId: "7001", quantity: 2 }],
          trackingCompany: "Fixture Carrier",
          trackingNumber: "TRACK-FIXTURE-001",
        }),
      ),
    ).toMatchObject({
      fulfillmentId: expect.any(String),
      orderId: "6001",
      status: "success",
      trackingCompany: "Fixture Carrier",
      trackingNumber: "TRACK-FIXTURE-001",
    });

    expect(
      executionOutput(
        await harness.execute("shopify.list_customers", { query: "Avery" }),
      ).customers,
    ).toEqual([
      expect.objectContaining({
        customerId: "5001",
        firstName: "Avery",
        totalSpent: 50,
      }),
    ]);
  });

  it("runs ticket, assignment, reply, and conversation flows through Zendesk", async () => {
    const provider = createZendeskMock();
    await provider.seed(zendeskFixtures.default);
    const harness = createBusinessMockHarness(provider, {
      type: "oauth2",
      accessToken: "fixture:valid",
    });

    expect(
      executionOutput(
        await harness.execute("zendesk.list_tickets", { status: "open" }),
      ).tickets,
    ).toEqual([
      expect.objectContaining({
        ticketId: "2001",
        requesterId: "1001",
        assigneeId: "1002",
      }),
    ]);
    expect(
      executionOutput(
        await harness.execute("zendesk.get_ticket", { ticketId: "2001" }),
      ).ticket,
    ).toMatchObject({ ticketId: "2001", subject: "Acme invoice question" });

    const createdTicket = executionOutput(
      await harness.execute("zendesk.create_ticket", {
        requesterEmail: "requester@fixtures.example",
        requesterName: "Fixture Requester",
        subject: "Fixture support request",
        description: "Please inspect the deterministic support fixture.",
        priority: "high",
        tags: ["fixture", "adapter"],
        customFields: { "42": "canonical" },
      }),
    ).ticket as Readonly<Record<string, unknown>>;
    const ticketId = String(createdTicket.ticketId);
    expect(createdTicket).toMatchObject({
      ticketId: expect.any(String),
      subject: "Fixture support request",
      priority: "high",
      customFields: { "42": "canonical" },
    });

    expect(
      executionOutput(
        await harness.execute("zendesk.update_ticket", {
          ticketId,
          status: "open",
          tags: ["fixture", "triaged"],
        }),
      ).ticket,
    ).toMatchObject({ ticketId, status: "open", tags: ["fixture", "triaged"] });
    expect(
      executionOutput(
        await harness.execute("zendesk.assign_ticket", {
          ticketId,
          assigneeId: "1002",
        }),
      ).ticket,
    ).toMatchObject({ ticketId, assigneeId: "1002" });

    expect(
      executionOutput(
        await harness.execute("zendesk.add_ticket_reply", {
          ticketId,
          authorId: "1002",
          body: "A fixture agent is investigating.",
          public: false,
        }),
      ).message,
    ).toMatchObject({
      conversationId: ticketId,
      authorId: "1002",
      body: "A fixture agent is investigating.",
      public: false,
    });

    expect(
      executionOutput(
        await harness.execute("zendesk.list_conversations", {
          status: "open",
          assigneeId: "1002",
        }),
      ).conversations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conversationId: ticketId, messageCount: 2 }),
      ]),
    );
    expect(
      executionOutput(
        await harness.execute("zendesk.get_conversation", {
          conversationId: ticketId,
        }),
      ),
    ).toMatchObject({
      conversation: expect.objectContaining({
        conversationId: ticketId,
        messageCount: 2,
      }),
      messages: expect.arrayContaining([
        expect.objectContaining({ body: "A fixture agent is investigating." }),
      ]),
    });
    expect(
      executionOutput(
        await harness.execute("zendesk.send_conversation_reply", {
          conversationId: ticketId,
          authorId: "1002",
          body: "The deterministic reply is complete.",
        }),
      ).message,
    ).toMatchObject({
      conversationId: ticketId,
      authorId: "1002",
      body: "The deterministic reply is complete.",
      public: true,
    });
  });
});
