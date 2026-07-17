import { describe, expect, it } from "vitest";
import type { CatalogSchema } from "./catalog";
import { buildSchemaFormFields, coerceSchemaFormValues } from "./schema-form";

const schema = {
  type: "object",
  required: ["subject", "priority"],
  properties: {
    subject: { type: "string", description: "Message subject." },
    priority: { type: "string", enum: ["low", "high"] },
    notify: { type: "boolean" },
    retries: { type: "integer" },
    metadata: { type: "object", additionalProperties: true },
    recipients: { type: "array", items: { type: "string" } },
  },
} as const satisfies CatalogSchema;

describe("schema form generator", () => {
  it("maps strings, enums, booleans, numbers, and compound JSON fields", () => {
    const fields = buildSchemaFormFields(schema);

    expect(
      fields.map(({ kind, name, required }) => ({ kind, name, required })),
    ).toEqual([
      { kind: "string", name: "subject", required: true },
      { kind: "enum", name: "priority", required: true },
      { kind: "boolean", name: "notify", required: false },
      { kind: "number", name: "retries", required: false },
      { kind: "json", name: "metadata", required: false },
      { kind: "json", name: "recipients", required: false },
    ]);
  });

  it("coerces generated values and reports invalid JSON without throwing", () => {
    const fields = buildSchemaFormFields(schema);
    const result = coerceSchemaFormValues(fields, {
      metadata: "{not-json}",
      notify: true,
      priority: "high",
      recipients: '["a@example.com"]',
      retries: "3",
      subject: "Launch",
    });

    expect(result.value).toEqual({
      notify: true,
      priority: "high",
      recipients: ["a@example.com"],
      retries: 3,
      subject: "Launch",
    });
    expect(result.errors).toEqual({ metadata: "Enter valid JSON." });
  });
});
