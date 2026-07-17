import { defineCapabilityFixtures } from "../fixtures.js";

export const crmFixtures = defineCapabilityFixtures("crm", {
  add_note: {
    input: (context) => ({
      recordType: "contact",
      recordId: context.value("CONTACT_ID", "hubspot_contact_default_000001"),
      body: "Contract fixture note.",
    }),
  },
  create_company: {
    input: { name: "Contract Fixture Company", domain: "contract.example" },
  },
  create_contact: {
    input: {
      email: "contract-contact@example.com",
      firstName: "Contract",
      lastName: "Fixture",
    },
  },
  create_deal: {
    input: { name: "Contract Fixture Deal", amount: 1250, currency: "USD" },
  },
  get_contact: {
    input: (context) => ({
      contactId: context.value("CONTACT_ID", "hubspot_contact_default_000001"),
    }),
  },
  list_activities: {
    input: (context) => ({
      recordType: "contact",
      recordId: context.value("CONTACT_ID", "hubspot_contact_default_000001"),
    }),
  },
  search_contacts: { input: { query: "Acme" } },
  update_company: {
    input: (context) => ({
      companyId: context.value("COMPANY_ID", "hubspot_company_default_000001"),
      phone: "+15550001111",
    }),
  },
  update_contact: {
    input: (context) => ({
      contactId: context.value("CONTACT_ID", "hubspot_contact_default_000001"),
      firstName: "Contract Updated",
    }),
  },
  update_deal: {
    input: (context) => ({
      dealId: context.value("DEAL_ID", "hubspot_deal_default_000001"),
      amount: 1500,
    }),
  },
});
