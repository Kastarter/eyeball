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
  it("detects staged-attachment arrays and coerces picked file references", () => {
    const attachmentSchema = {
      type: "object",
      properties: {
        subject: { type: "string" },
        attachments: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                required: ["fileId"],
                properties: { fileId: { type: "string" } },
              },
              { type: "string" },
            ],
          },
        },
        labels: { type: "array", items: { type: "string" } },
      },
    } as const;
    const fields = buildSchemaFormFields(attachmentSchema);

    expect(fields.map(({ kind, name }) => ({ kind, name }))).toEqual([
      { kind: "string", name: "subject" },
      { kind: "attachments", name: "attachments" },
      { kind: "json", name: "labels" },
    ]);

    const picked = coerceSchemaFormValues(fields, {
      attachments: "file_alpha, file_beta",
      subject: "Launch",
    });
    expect(picked.errors).toEqual({});
    expect(picked.value).toEqual({
      attachments: [{ fileId: "file_alpha" }, { fileId: "file_beta" }],
      subject: "Launch",
    });

    const empty = coerceSchemaFormValues(fields, {
      attachments: "",
      subject: "Launch",
    });
    expect(empty.value).toEqual({ subject: "Launch" });

    const invalid = coerceSchemaFormValues(fields, {
      attachments: "not-a-file-id",
      subject: "Launch",
    });
    expect(invalid.errors).toEqual({
      attachments: "Attachments must be staged file_* identifiers.",
    });
  });
});
