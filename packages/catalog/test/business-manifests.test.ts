import { validateInput } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  crmCapabilityContracts,
  crmContractsByName,
  defaultCatalog,
  ecommerceCapabilityContracts,
  ecommerceContractsByName,
  erpCapabilityContracts,
  erpContractsByName,
  hubSpotManifest,
  odooManifest,
  paymentsCapabilityContracts,
  paymentsContractsByName,
  quickBooksManifest,
  shopifyManifest,
  stripeManifest,
  supportCapabilityContracts,
  supportContractsByName,
  zendeskManifest,
} from "../src/index.js";

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected business catalog fixture to be defined.");
  }
  return value;
}

describe("business capability contracts and manifests", () => {
  it("publishes the complete catalog 1.0 business contract inventory", () => {
    expect(crmCapabilityContracts).toHaveLength(10);
    expect(erpCapabilityContracts).toHaveLength(12);
    expect(paymentsCapabilityContracts).toHaveLength(10);
    expect(ecommerceCapabilityContracts).toHaveLength(10);
    expect(supportCapabilityContracts).toHaveLength(9);

    expect(defaultCatalog.listTools({ capability: "crm" })).toHaveLength(9);
    expect(
      defaultCatalog.listTools({ capability: "erp_accounting" }),
    ).toHaveLength(16);
    expect(
      defaultCatalog.listTools({ capability: "payments_billing" }),
    ).toHaveLength(10);
    expect(defaultCatalog.listTools({ capability: "ecommerce" })).toHaveLength(
      10,
    );
    expect(
      defaultCatalog.listTools({ capability: "customer_support" }),
    ).toHaveLength(9);
  });

  it("enforces dependent selectors, mutation payloads, and payment targets", () => {
    expect(
      validateInput(crmContractsByName.search_contacts, {
        property: "lifecyclestage",
      }).ok,
    ).toBe(false);
    expect(
      validateInput(crmContractsByName.update_contact, {
        contactId: "contact_1",
      }).ok,
    ).toBe(false);
    expect(
      validateInput(erpContractsByName.record_payment, { amount: 25 }).ok,
    ).toBe(false);
    expect(
      validateInput(erpContractsByName.record_payment, {
        customerId: "customer_1",
        amount: 25,
      }).ok,
    ).toBe(true);
    expect(
      validateInput(ecommerceContractsByName.update_product, {
        productId: "product_1",
      }).ok,
    ).toBe(false);
    expect(
      validateInput(supportContractsByName.create_ticket, {
        requesterEmail: "requester@example.com",
        subject: "Fixture request",
        description: "A deterministic support request.",
      }).ok,
    ).toBe(true);
  });

  it("marks refunds and subscription cancellation as destructive", () => {
    expect(
      paymentsCapabilityContracts
        .filter(({ annotations }) => annotations.destructive)
        .map(({ name }) => name),
    ).toEqual(["create_refund", "cancel_subscription"]);
    expect(paymentsContractsByName.create_refund.annotations.readOnly).toBe(
      false,
    );
    expect(
      paymentsContractsByName.cancel_subscription.annotations.idempotent,
    ).toBe(true);
  });

  it("materializes each P0 mock-backed provider subset and auth class", () => {
    expect(hubSpotManifest.implements).toHaveLength(9);
    expect(odooManifest.implements).toHaveLength(9);
    expect(quickBooksManifest.implements).toHaveLength(7);
    expect(stripeManifest.implements).toHaveLength(10);
    expect(shopifyManifest.implements).toHaveLength(10);
    expect(zendeskManifest.implements).toHaveLength(9);

    expect(hubSpotManifest.auth.class).toBe("oauth2");
    expect(odooManifest.auth).toEqual({
      class: "basic",
      fields: ["database", "username", "apiKey"],
    });
    expect(quickBooksManifest.auth.class).toBe("oauth2");
    expect(stripeManifest.auth).toEqual({
      class: "api_key",
      fields: ["apiKey"],
    });
    expect(shopifyManifest.auth.class).toBe("oauth2");
    expect(zendeskManifest.auth.class).toBe("oauth2");
  });

  it("requires QuickBooks realm context through its provider namespace", () => {
    const tool = defaultCatalog.getTool("quickbooks.create_customer");
    expect(tool).toBeDefined();
    expect(
      validateInput(defined(tool), {
        name: "Fixture Customer",
        x_provider: { quickbooks: { realmId: "realm_fixture" } },
      }).ok,
    ).toBe(true);
    expect(
      validateInput(defined(tool), {
        name: "Fixture Customer",
        x_provider: { quickbooks: {} },
      }).ok,
    ).toBe(false);
  });

  it("freezes every business manifest and endpoint override", () => {
    for (const manifest of [
      hubSpotManifest,
      odooManifest,
      quickBooksManifest,
      stripeManifest,
      shopifyManifest,
      zendeskManifest,
    ]) {
      expect(manifest.endpoint.baseUrlOverrideEnv).toMatch(
        /^EYEBALL_[A-Z0-9_]+_BASE_URL$/u,
      );
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.implements)).toBe(true);
    }
  });
});
