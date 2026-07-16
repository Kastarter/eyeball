import {
  type CapabilityToolContract,
  JSON_SCHEMA_DRAFT_2020_12,
  validateInput,
} from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  CatalogRegistry,
  emailCapabilityContracts,
  emailContractsByName,
  messagingCapabilityContracts,
  messagingContractsByName,
} from "../src/index.js";

const contracts: readonly CapabilityToolContract[] = [
  ...emailCapabilityContracts,
  ...messagingCapabilityContracts,
];

describe("published capability contracts", () => {
  it("registers all email and messaging contracts without collisions", () => {
    const registry = new CatalogRegistry({ contracts });
    expect(registry.listContracts({ capability: "email" })).toHaveLength(8);
    expect(
      registry.listContracts({ capability: "messaging_chat" }),
    ).toHaveLength(8);
  });

  it("publishes closed Draft 2020-12 schemas without provider fields", () => {
    const schemaIds = new Set<string>();
    for (const contract of contracts) {
      for (const schema of [contract.inputSchema, contract.outputSchema]) {
        if (schema === undefined) continue;
        expect(schema.$schema).toBe(JSON_SCHEMA_DRAFT_2020_12);
        expect(schema.$id).toMatch(/^urn:eyeball:/);
        expect(schema.type).toBe("object");
        expect(schema.additionalProperties).toBe(false);
        expect(schema.properties?.x_provider).toBeUndefined();
        expect(schemaIds.has(schema.$id ?? "")).toBe(false);
        schemaIds.add(schema.$id ?? "");
      }
    }
  });

  it("validates and defaults canonical email input", () => {
    const result = validateInput(emailContractsByName.send_email, {
      to: ["recipient@example.com"],
      subject: "Catalog conformance",
      body: "Hello",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        to: ["recipient@example.com"],
        subject: "Catalog conformance",
        body: "Hello",
        bodyFormat: "text",
      },
    });
  });

  it("enforces messaging identifiers and defaults", () => {
    expect(
      validateInput(messagingContractsByName.send_message, {
        conversationId: "channel_123",
        text: "Hello",
      }).ok,
    ).toBe(true);
    expect(
      validateInput(messagingContractsByName.send_message, { text: "Hello" }),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ keyword: "required" })],
    });
    expect(validateInput(messagingContractsByName.list_channels, {})).toEqual({
      ok: true,
      value: { includeArchived: false, pageSize: 50 },
    });
  });
});
