import type { CapabilityToolContract, JSONSchema202012 } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import {
  defineContract,
  nextPageTokenProperty,
  pageSizeProperty,
  pageTokenProperty,
  publishedObjectSchema,
} from "./schema.js";

const CAPABILITY = "crm" as const;
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

function properties(description: string): JSONSchema202012 {
  return {
    type: "object",
    description,
    additionalProperties: true,
  };
}

function contactSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized CRM contact.",
    additionalProperties: false,
    required: ["contactId", "createdAt", "updatedAt"],
    properties: {
      contactId: id("Provider identifier of the contact."),
      email: {
        type: "string",
        format: "email",
        description: "Contact email address.",
      },
      firstName: { type: "string", description: "Contact given name." },
      lastName: { type: "string", description: "Contact family name." },
      phone: { type: "string", description: "Contact phone number." },
      companyName: {
        type: "string",
        description: "Company name stored on the contact.",
      },
      properties: properties(
        "Provider-neutral contact properties returned by the CRM.",
      ),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Contact creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent contact update timestamp.",
      },
    },
  };
}

function companySchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized CRM company.",
    additionalProperties: false,
    required: ["companyId", "name", "createdAt", "updatedAt"],
    properties: {
      companyId: id("Provider identifier of the company."),
      name: { type: "string", description: "Company name." },
      domain: { type: "string", description: "Company website domain." },
      phone: { type: "string", description: "Company phone number." },
      properties: properties(
        "Provider-neutral company properties returned by the CRM.",
      ),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Company creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent company update timestamp.",
      },
    },
  };
}

function dealSchema(): JSONSchema202012 {
  return {
    type: "object",
    description: "A normalized CRM deal or opportunity.",
    additionalProperties: false,
    required: ["dealId", "name", "createdAt", "updatedAt"],
    properties: {
      dealId: id("Provider identifier of the deal."),
      name: { type: "string", description: "Deal or opportunity name." },
      amount: {
        type: "number",
        description: "Deal amount in major currency units.",
        minimum: 0,
      },
      currency: {
        type: "string",
        description: "ISO 4217 currency code.",
        pattern: "^[A-Z]{3}$",
      },
      stage: {
        type: "string",
        description: "Provider pipeline stage identifier.",
      },
      pipeline: {
        type: "string",
        description: "Provider pipeline identifier.",
      },
      properties: properties(
        "Provider-neutral deal properties returned by the CRM.",
      ),
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Deal creation timestamp.",
      },
      updatedAt: {
        type: "string",
        format: "date-time",
        description: "Most recent deal update timestamp.",
      },
    },
  };
}

const contactInputProperties = {
  email: {
    type: "string",
    format: "email",
    description: "Primary contact email address.",
  },
  firstName: { type: "string", description: "Contact given name." },
  lastName: { type: "string", description: "Contact family name." },
  phone: { type: "string", description: "Contact phone number." },
  companyName: {
    type: "string",
    description: "Company name associated with the contact.",
  },
  properties: properties(
    "Additional canonical CRM properties to store on the contact.",
  ),
} as const;

const dealInputProperties = {
  name: {
    type: "string",
    description: "Deal or opportunity name.",
    minLength: 1,
  },
  amount: {
    type: "number",
    description: "Deal amount in major currency units.",
    minimum: 0,
  },
  currency: {
    type: "string",
    description: "ISO 4217 currency code.",
    pattern: "^[A-Z]{3}$",
  },
  stage: {
    type: "string",
    description: "Provider pipeline stage identifier.",
    minLength: 1,
  },
  pipeline: {
    type: "string",
    description: "Provider pipeline identifier.",
    minLength: 1,
  },
  contactId: id("Contact to associate with the deal when supported."),
  companyId: id("Company to associate with the deal when supported."),
  properties: properties(
    "Additional canonical CRM properties to store on the deal.",
  ),
} as const;

const createContact = defineContract({
  capability: CAPABILITY,
  name: "create_contact",
  description:
    "Create a CRM contact from a person identity and portable properties. Use this only after checking for an existing contact when duplicates matter.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_contact",
    direction: "input",
    description: "Identity and properties for a new CRM contact.",
    required: ["email"],
    properties: contactInputProperties,
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_contact",
    direction: "output",
    description: "The newly created CRM contact.",
    required: ["contact"],
    properties: { contact: contactSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const getContact = defineContract({
  capability: CAPABILITY,
  name: "get_contact",
  description: "Retrieve one CRM contact by its provider identifier.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_contact",
    direction: "input",
    description: "Identifier of the contact to retrieve.",
    required: ["contactId"],
    properties: { contactId: id("Provider identifier of the contact.") },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "get_contact",
    direction: "output",
    description: "The requested CRM contact.",
    required: ["contact"],
    properties: { contact: contactSchema() },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const searchContacts = defineContract({
  capability: CAPABILITY,
  name: "search_contacts",
  description:
    "Search CRM contacts by email, portable property, or free-text identity query and return a normalized page.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "search_contacts",
      direction: "input",
      description: "Contact search selectors and pagination.",
      properties: {
        query: {
          type: "string",
          description: "Free-text identity query supported by the provider.",
          minLength: 1,
        },
        email: {
          type: "string",
          format: "email",
          description: "Exact email address to match.",
        },
        property: {
          type: "string",
          description: "Provider property name to match.",
          minLength: 1,
        },
        value: {
          type: ["string", "number", "boolean"],
          description: "Exact value for the selected property.",
        },
        pageSize: pageSizeProperty("contact search results"),
        pageToken: pageTokenProperty("contact search result"),
      },
    }),
    dependentRequired: {
      property: ["value"],
      value: ["property"],
    },
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "search_contacts",
    direction: "output",
    description: "One page of matching CRM contacts.",
    required: ["contacts"],
    properties: {
      contacts: {
        type: "array",
        description: "Contacts matching the search.",
        items: contactSchema(),
      },
      nextPageToken: nextPageTokenProperty("contact search results"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const updateContact = defineContract({
  capability: CAPABILITY,
  name: "update_contact",
  description:
    "Update portable fields on an existing CRM contact. Repeating the same field values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_contact",
      direction: "input",
      description: "Contact identifier and fields to update.",
      required: ["contactId"],
      properties: {
        contactId: id("Provider identifier of the contact."),
        ...contactInputProperties,
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_contact",
    direction: "output",
    description: "The updated CRM contact.",
    required: ["contact"],
    properties: { contact: contactSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const createCompany = defineContract({
  capability: CAPABILITY,
  name: "create_company",
  description: "Create a CRM company, organization, or account record.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_company",
    direction: "input",
    description: "Identity and properties for a new company.",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Company name.", minLength: 1 },
      domain: {
        type: "string",
        description: "Company website domain.",
        minLength: 1,
      },
      phone: { type: "string", description: "Company phone number." },
      properties: properties(
        "Additional canonical CRM properties to store on the company.",
      ),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_company",
    direction: "output",
    description: "The newly created CRM company.",
    required: ["company"],
    properties: { company: companySchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const updateCompany = defineContract({
  capability: CAPABILITY,
  name: "update_company",
  description:
    "Update portable fields on an existing CRM company, organization, or account. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_company",
      direction: "input",
      description: "Company identifier and fields to update.",
      required: ["companyId"],
      properties: {
        companyId: id("Provider identifier of the company."),
        name: { type: "string", description: "Company name.", minLength: 1 },
        domain: {
          type: "string",
          description: "Company website domain.",
          minLength: 1,
        },
        phone: { type: "string", description: "Company phone number." },
        properties: properties(
          "Additional canonical CRM properties to store on the company.",
        ),
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_company",
    direction: "output",
    description: "The updated CRM company.",
    required: ["company"],
    properties: { company: companySchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const createDeal = defineContract({
  capability: CAPABILITY,
  name: "create_deal",
  description:
    "Create a CRM deal or opportunity in a pipeline with portable amount and stage fields.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_deal",
    direction: "input",
    description: "Pipeline fields and optional associations for a new deal.",
    required: ["name"],
    properties: {
      ...dealInputProperties,
      currency: {
        type: "string",
        description: "ISO 4217 currency code.",
        pattern: "^[A-Z]{3}$",
        default: "USD",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "create_deal",
    direction: "output",
    description: "The newly created CRM deal.",
    required: ["deal"],
    properties: { deal: dealSchema() },
  }),
  annotations: CREATE,
  version: VERSION,
});

const updateDeal = defineContract({
  capability: CAPABILITY,
  name: "update_deal",
  description:
    "Update an existing CRM deal's fields, stage, amount, or pipeline. Repeating the same values has no additional effect.",
  inputSchema: {
    ...publishedObjectSchema({
      capability: CAPABILITY,
      tool: "update_deal",
      direction: "input",
      description: "Deal identifier and fields to update.",
      required: ["dealId"],
      properties: {
        dealId: id("Provider identifier of the deal."),
        ...dealInputProperties,
      },
    }),
    minProperties: 2,
  },
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "update_deal",
    direction: "output",
    description: "The updated CRM deal.",
    required: ["deal"],
    properties: { deal: dealSchema() },
  }),
  annotations: UPDATE,
  version: VERSION,
});

const listActivities = defineContract({
  capability: CAPABILITY,
  name: "list_activities",
  description:
    "List calls, meetings, tasks, or timeline activities associated with a CRM contact, company, or deal.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_activities",
    direction: "input",
    description: "Associated CRM record, activity filters, and pagination.",
    required: ["recordType", "recordId"],
    properties: {
      recordType: {
        type: "string",
        description: "Kind of CRM record whose activities should be listed.",
        enum: ["contact", "company", "deal"],
      },
      recordId: id("Provider identifier of the associated CRM record."),
      activityTypes: {
        type: "array",
        description: "Activity kinds to include when supported.",
        items: {
          type: "string",
          enum: ["call", "meeting", "task", "email", "note", "other"],
        },
      },
      occurredAfter: {
        type: "string",
        format: "date-time",
        description: "Return activities at or after this timestamp.",
      },
      occurredBefore: {
        type: "string",
        format: "date-time",
        description: "Return activities before this timestamp.",
      },
      pageSize: pageSizeProperty("activities"),
      pageToken: pageTokenProperty("activity"),
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "list_activities",
    direction: "output",
    description: "One page of normalized CRM activities.",
    required: ["activities"],
    properties: {
      activities: {
        type: "array",
        description: "Activities associated with the selected CRM record.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "activityId",
            "type",
            "recordType",
            "recordId",
            "occurredAt",
          ],
          properties: {
            activityId: id("Provider identifier of the activity."),
            type: {
              type: "string",
              description: "Normalized activity kind.",
              enum: ["call", "meeting", "task", "email", "note", "other"],
            },
            recordType: {
              type: "string",
              description: "Kind of associated CRM record.",
              enum: ["contact", "company", "deal"],
            },
            recordId: id("Provider identifier of the associated CRM record."),
            subject: {
              type: "string",
              description: "Activity subject or title.",
            },
            body: {
              type: "string",
              description: "Activity content or summary.",
            },
            ownerId: id("Provider identifier of the activity owner."),
            occurredAt: {
              type: "string",
              format: "date-time",
              description: "Activity timestamp.",
            },
          },
        },
      },
      nextPageToken: nextPageTokenProperty("activities"),
    },
  }),
  annotations: READ_ONLY,
  version: VERSION,
});

const addNote = defineContract({
  capability: CAPABILITY,
  name: "add_note",
  description:
    "Add a timeline note to a CRM contact, company, or deal. This creates externally visible CRM history.",
  inputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_note",
    direction: "input",
    description: "Associated CRM record and note content.",
    required: ["recordType", "recordId", "body"],
    properties: {
      recordType: {
        type: "string",
        description: "Kind of CRM record receiving the note.",
        enum: ["contact", "company", "deal"],
      },
      recordId: id("Provider identifier of the associated CRM record."),
      body: {
        type: "string",
        description: "Plain-text note content.",
        minLength: 1,
      },
      occurredAt: {
        type: "string",
        format: "date-time",
        description:
          "Timestamp represented by the note; defaults to provider time.",
      },
    },
  }),
  outputSchema: publishedObjectSchema({
    capability: CAPABILITY,
    tool: "add_note",
    direction: "output",
    description: "Identifiers and timestamp for the created CRM note.",
    required: ["noteId", "recordType", "recordId", "body", "createdAt"],
    properties: {
      noteId: id("Provider identifier of the note."),
      recordType: {
        type: "string",
        description: "Kind of associated CRM record.",
        enum: ["contact", "company", "deal"],
      },
      recordId: id("Provider identifier of the associated CRM record."),
      body: { type: "string", description: "Stored note content." },
      createdAt: {
        type: "string",
        format: "date-time",
        description: "Note creation timestamp.",
      },
    },
  }),
  annotations: CREATE,
  version: VERSION,
});

export const crmCapabilityContracts = deepFreeze([
  createContact,
  getContact,
  searchContacts,
  updateContact,
  createCompany,
  updateCompany,
  createDeal,
  updateDeal,
  listActivities,
  addNote,
] as const satisfies readonly CapabilityToolContract[]);

type CrmContract = (typeof crmCapabilityContracts)[number];
type CrmContractsByName = {
  readonly [Contract in CrmContract as Contract["name"]]: Contract;
};

export const crmContractsByName = deepFreeze(
  Object.fromEntries(
    crmCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as CrmContractsByName,
);
