import { describe, expect, it } from "vitest";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type ToolDefinition,
  validateInput,
} from "../src/index.js";

const tool: ToolDefinition = {
  name: "gmail.send_email",
  toolkit: "gmail",
  capability: "email",
  description: "Send an email.",
  version: "1.0.0",
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["to", "body"],
    properties: {
      to: { type: "string", format: "email" },
      body: { type: "string", minLength: 1 },
      bodyFormat: { type: ["string", "null"], default: "text" },
    },
  },
};

describe("input schema validation", () => {
  it("validates, clones, and inserts declared defaults", () => {
    const input = { to: "buyer@example.com", body: "Thanks" };
    const result = validateInput(tool, input);

    expect(result).toEqual({
      ok: true,
      value: {
        to: "buyer@example.com",
        body: "Thanks",
        bodyFormat: "text",
      },
    });
    expect(input).not.toHaveProperty("bodyFormat");
  });

  it("validates defensive schema copies that retain the same canonical id", () => {
    const identifiedTool = {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        $id: "urn:eyeball:test:send_email:1.0.0:gmail",
      },
    } satisfies ToolDefinition;
    const copiedTool = structuredClone(identifiedTool);

    expect(
      validateInput(identifiedTool, {
        to: "buyer@example.com",
        body: "First",
      }).ok,
    ).toBe(true);
    expect(
      validateInput(copiedTool, {
        to: "buyer@example.com",
        body: "Second",
      }).ok,
    ).toBe(true);
  });

  it("rejects conflicting definitions that reuse a canonical schema id", () => {
    const first = {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        $id: "urn:eyeball:test:conflicting-schema:1.0.0",
      },
    } satisfies ToolDefinition;
    const conflicting = {
      ...first,
      inputSchema: {
        ...first.inputSchema,
        required: ["to", "body", "bodyFormat"],
      },
    } satisfies ToolDefinition;

    expect(
      validateInput(first, { to: "buyer@example.com", body: "First" }).ok,
    ).toBe(true);
    expect(
      validateInput(conflicting, {
        to: "buyer@example.com",
        body: "Second",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        {
          keyword: "schema_profile",
          message: expect.stringContaining("different definition"),
        },
      ],
    });
  });

  it("does not replace an explicitly supplied null with a default", () => {
    const result = validateInput(tool, {
      to: "buyer@example.com",
      body: "Thanks",
      bodyFormat: null,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { bodyFormat: null },
    });
  });

  it("accepts Draft 2020-12 union types beyond nullable values", () => {
    const unionTool = {
      ...tool,
      inputSchema: {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        type: "object" as const,
        additionalProperties: false,
        properties: { value: { type: ["string", "integer"] } },
      },
    } satisfies ToolDefinition;

    expect(validateInput(unionTool, { value: "one" }).ok).toBe(true);
    expect(validateInput(unionTool, { value: 1 }).ok).toBe(true);
  });

  it.each([
    [{ body: "Thanks" }, "required"],
    [{ to: "not-an-email", body: "Thanks" }, "format"],
    [{ to: "buyer@example.com", body: "" }, "minLength"],
    [
      { to: "buyer@example.com", body: "Thanks", unexpected: true },
      "additionalProperties",
    ],
  ] as const)("maps invalid input to invalid_input details", (input, keyword) => {
    const result = validateInput(tool, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "invalid_input", keyword }),
        ]),
      );
    }
  });

  it("requires the runtime input itself to be an object", () => {
    const result = validateInput(tool, ["not", "an", "object"]);
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "invalid_input",
          instancePath: "",
          schemaPath: "",
          keyword: "type",
          message: "Input must be an object.",
          params: {},
        },
      ],
    });
  });

  it("enforces the published-schema Draft 2020-12 profile", () => {
    const missingDraft = {
      inputSchema: { type: "object" },
    } as Pick<ToolDefinition, "inputSchema">;
    const result = validateInput(missingDraft, {});
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "invalid_input", keyword: "schema_profile" }],
    });
  });

  it("enforces an object schema root at runtime", () => {
    const arrayRoot = {
      inputSchema: {
        $schema: JSON_SCHEMA_DRAFT_2020_12,
        type: "array",
      },
    } as unknown as Pick<ToolDefinition, "inputSchema">;
    const result = validateInput(arrayRoot, {});
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "invalid_input", keyword: "schema_profile" }],
    });
  });
});
