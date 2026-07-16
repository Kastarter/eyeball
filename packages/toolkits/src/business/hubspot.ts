import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import {
  asJson,
  finiteNumber,
  idValue,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringValue,
  unsupported,
} from "./common.js";

function canonicalProperties(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const extra = recordValue(input, "properties");
  return extra === undefined ? {} : { ...extra };
}

function hubSpotProperties(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const properties = value.properties;
  if (!isRecord(properties)) {
    throw providerError(
      context,
      "HubSpot returned an object without properties.",
    );
  }
  return properties;
}

function contact(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const properties = hubSpotProperties(context, value);
  return {
    contactId: requiredId(context, value.id, "contact"),
    ...(stringValue(properties, "email") === undefined
      ? {}
      : { email: stringValue(properties, "email") }),
    ...(stringValue(properties, "firstname") === undefined
      ? {}
      : { firstName: stringValue(properties, "firstname") }),
    ...(stringValue(properties, "lastname") === undefined
      ? {}
      : { lastName: stringValue(properties, "lastname") }),
    ...(stringValue(properties, "phone") === undefined
      ? {}
      : { phone: stringValue(properties, "phone") }),
    ...(stringValue(properties, "company") === undefined
      ? {}
      : { companyName: stringValue(properties, "company") }),
    properties,
    createdAt: requiredString(context, value, "createdAt"),
    updatedAt: requiredString(context, value, "updatedAt"),
  };
}

function company(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const properties = hubSpotProperties(context, value);
  return {
    companyId: requiredId(context, value.id, "company"),
    name: requiredString(context, properties, "name"),
    ...(stringValue(properties, "domain") === undefined
      ? {}
      : { domain: stringValue(properties, "domain") }),
    ...(stringValue(properties, "phone") === undefined
      ? {}
      : { phone: stringValue(properties, "phone") }),
    properties,
    createdAt: requiredString(context, value, "createdAt"),
    updatedAt: requiredString(context, value, "updatedAt"),
  };
}

function deal(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const properties = hubSpotProperties(context, value);
  const rawAmount = properties.amount;
  const amount =
    rawAmount === undefined
      ? undefined
      : finiteNumber(context, rawAmount, "amount");
  return {
    dealId: requiredId(context, value.id, "deal"),
    name: requiredString(context, properties, "dealname"),
    ...(amount === undefined ? {} : { amount }),
    ...(stringValue(properties, "currency") === undefined
      ? {}
      : { currency: stringValue(properties, "currency")?.toUpperCase() }),
    ...(stringValue(properties, "dealstage") === undefined
      ? {}
      : { stage: stringValue(properties, "dealstage") }),
    ...(stringValue(properties, "pipeline") === undefined
      ? {}
      : { pipeline: stringValue(properties, "pipeline") }),
    properties,
    createdAt: requiredString(context, value, "createdAt"),
    updatedAt: requiredString(context, value, "updatedAt"),
  };
}

function contactInput(input: Readonly<Record<string, unknown>>) {
  const properties = canonicalProperties(input);
  const mappings = [
    ["email", "email"],
    ["firstName", "firstname"],
    ["lastName", "lastname"],
    ["phone", "phone"],
    ["companyName", "company"],
  ] as const;
  for (const [source, target] of mappings) {
    const value = stringValue(input, source);
    if (value !== undefined) properties[target] = value;
  }
  return properties;
}

function companyInput(input: Readonly<Record<string, unknown>>) {
  const properties = canonicalProperties(input);
  for (const key of ["name", "domain", "phone"] as const) {
    const value = stringValue(input, key);
    if (value !== undefined) properties[key] = value;
  }
  return properties;
}

function dealInput(input: Readonly<Record<string, unknown>>) {
  const properties = canonicalProperties(input);
  const name = stringValue(input, "name");
  const stage = stringValue(input, "stage");
  const pipeline = stringValue(input, "pipeline");
  const currency = stringValue(input, "currency");
  if (name !== undefined) properties.dealname = name;
  if (typeof input.amount === "number")
    properties.amount = String(input.amount);
  if (stage !== undefined) properties.dealstage = stage;
  if (pipeline !== undefined) properties.pipeline = pipeline;
  if (currency !== undefined) properties.currency = currency;
  return properties;
}

async function createObject(
  context: AdapterContext,
  objectType: "contacts" | "companies" | "deals",
  properties: Readonly<Record<string, unknown>>,
) {
  return jsonObject(
    context,
    `crm/v3/objects/${objectType}`,
    jsonRequest({ properties }),
  );
}

async function updateObject(
  context: AdapterContext,
  objectType: "contacts" | "companies" | "deals",
  objectId: string,
  properties: Readonly<Record<string, unknown>>,
) {
  return jsonObject(
    context,
    `crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`,
    jsonRequest({ properties }, "PATCH"),
  );
}

export class HubSpotAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "hubspot";

  async execute(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    switch (context.tool.name) {
      case "hubspot.create_contact":
        return asJson({
          contact: contact(
            context,
            await createObject(context, "contacts", contactInput(input)),
          ),
        });
      case "hubspot.get_contact":
        return this.getContact(context);
      case "hubspot.search_contacts":
        return this.searchContacts(context);
      case "hubspot.update_contact":
        return asJson({
          contact: contact(
            context,
            await updateObject(
              context,
              "contacts",
              inputString(context, "contactId"),
              contactInput(input),
            ),
          ),
        });
      case "hubspot.create_company":
        return asJson({
          company: company(
            context,
            await createObject(context, "companies", companyInput(input)),
          ),
        });
      case "hubspot.update_company":
        return asJson({
          company: company(
            context,
            await updateObject(
              context,
              "companies",
              inputString(context, "companyId"),
              companyInput(input),
            ),
          ),
        });
      case "hubspot.create_deal":
        return asJson({
          deal: deal(
            context,
            await createObject(context, "deals", dealInput(input)),
          ),
        });
      case "hubspot.update_deal":
        return asJson({
          deal: deal(
            context,
            await updateObject(
              context,
              "deals",
              inputString(context, "dealId"),
              dealInput(input),
            ),
          ),
        });
      case "hubspot.add_note":
        return this.addNote(context);
      default:
        return unsupported(context);
    }
  }

  private async getContact(context: AdapterContext): Promise<JsonValue> {
    const result = await jsonObject(
      context,
      `crm/v3/objects/contacts/${encodeURIComponent(inputString(context, "contactId"))}`,
    );
    return asJson({ contact: contact(context, result) });
  }

  private async searchContacts(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const filters: Record<string, unknown>[] = [];
    const email = stringValue(input, "email");
    const property = stringValue(input, "property");
    if (email !== undefined) {
      filters.push({ propertyName: "email", operator: "EQ", value: email });
    }
    if (property !== undefined && input.value !== undefined) {
      filters.push({
        propertyName: property,
        operator: "EQ",
        value: input.value,
      });
    }
    const query = stringValue(input, "query");
    const filterGroups =
      filters.length > 0
        ? [{ filters }]
        : query === undefined
          ? []
          : ["email", "firstname", "lastname", "company"].map(
              (propertyName) => ({
                filters: [
                  {
                    propertyName,
                    operator: "CONTAINS_TOKEN",
                    value: query,
                  },
                ],
              }),
            );
    const body = await jsonObject(
      context,
      "crm/v3/objects/contacts/search",
      jsonRequest({
        filterGroups,
        limit: input.pageSize,
        after: stringValue(input, "pageToken") ?? "0",
      }),
    );
    const paging = recordValue(body, "paging");
    const next = paging === undefined ? undefined : recordValue(paging, "next");
    const nextPageToken = next === undefined ? undefined : idValue(next.after);
    return asJson({
      contacts: records(body.results).map((value) => contact(context, value)),
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    });
  }

  private async addNote(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const recordType = inputString(context, "recordType");
    const objectType = `${recordType}s`;
    const body = inputString(context, "body");
    const result = await jsonObject(
      context,
      "crm/v3/objects/notes",
      jsonRequest({
        properties: {
          hs_note_body: body,
          hs_timestamp:
            stringValue(input, "occurredAt") ??
            context.clock.now().toISOString(),
        },
        associatedObjectType: objectType,
        associatedObjectId: inputString(context, "recordId"),
      }),
    );
    const associationResults = recordValue(
      recordValue(result, "associations") ?? {},
      objectType,
    )?.results;
    const association = records(associationResults)[0];
    return asJson({
      noteId: requiredId(context, result.id, "note"),
      recordType,
      recordId:
        association === undefined
          ? inputString(context, "recordId")
          : requiredId(context, association.id, "associated record"),
      body,
      createdAt: requiredString(context, result, "createdAt"),
    });
  }
}

export const hubSpotAdapter = new HubSpotAdapter();
