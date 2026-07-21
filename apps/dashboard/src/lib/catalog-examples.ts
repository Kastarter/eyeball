import { defaultCatalog } from "@eyeball/catalog";
import {
  type JSONSchema202012,
  type JsonValue,
  type ObjectSchema202012,
  validateInput,
} from "@eyeball/core";

function referencedSchema(
  schema: JSONSchema202012,
  root: ObjectSchema202012,
): JSONSchema202012 {
  if (
    schema !== true &&
    schema !== false &&
    schema.$ref?.startsWith("#/$defs/")
  ) {
    const name = schema.$ref.slice("#/$defs/".length);
    return root.$defs?.[name] ?? schema;
  }
  return schema;
}

function exampleValue(
  initial: JSONSchema202012 | undefined,
  root: ObjectSchema202012,
  propertyName = "value",
  depth = 0,
): JsonValue {
  if (
    initial === undefined ||
    initial === true ||
    initial === false ||
    depth > 12
  ) {
    return null;
  }
  const schema = referencedSchema(initial, root);
  if (schema === true || schema === false) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.[0] !== undefined) return schema.enum[0];
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch !== undefined) {
    return exampleValue(branch, root, propertyName, depth + 1);
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    const result: Record<string, JsonValue> = {};
    for (const required of schema.required ?? []) {
      result[required] = exampleValue(
        schema.properties?.[required],
        root,
        required,
        depth + 1,
      );
    }
    return result;
  }
  if (schema.type === "array") {
    return (schema.minItems ?? 0) > 0
      ? [exampleValue(schema.items, root, propertyName, depth + 1)]
      : [];
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "integer" || schema.type === "number") {
    return schema.minimum ?? 1;
  }
  if (schema.type === "null") return null;
  if (schema.format === "email") return "demo@example.com";
  if (schema.format === "date") return "2026-07-21";
  if (schema.format === "date-time") return "2026-07-21T12:00:00.000Z";
  if (schema.format === "uri") return "https://example.com/resource";
  if (schema.format === "uuid") {
    return "00000000-0000-4000-8000-000000000001";
  }
  if (schema.pattern?.includes("\\+")) return "+12025550123";
  if (/^(to|from|phoneNumber)$/iu.test(propertyName)) return "+12025550123";
  if (/email/iu.test(propertyName)) return "demo@example.com";
  if (/timeZone/iu.test(propertyName)) return "UTC";
  if (/^(start|end)$/iu.test(propertyName)) {
    return propertyName === "start" ? "09:00" : "17:00";
  }
  return `example_${propertyName}`;
}

function catalogTool(toolName: string) {
  const tool = defaultCatalog.getTool(toolName);
  if (tool === undefined) {
    throw new Error(`Catalog tool ${toolName} is not available.`);
  }
  return tool;
}

export function validateCatalogExampleInput(
  toolName: string,
  input: unknown,
): Readonly<Record<string, JsonValue>> {
  const tool = catalogTool(toolName);
  const validated = validateInput(tool, input);
  if (!validated.ok) {
    throw new Error(
      `Example input for ${toolName} does not satisfy its catalog schema: ${JSON.stringify(validated.errors)}`,
    );
  }
  return validated.value;
}

export function createCatalogExampleInput(
  toolName: string,
): Readonly<Record<string, JsonValue>> {
  const tool = catalogTool(toolName);
  const generated = exampleValue(tool.inputSchema, tool.inputSchema);
  const input =
    typeof generated === "object" &&
    generated !== null &&
    !Array.isArray(generated)
      ? generated
      : {};
  return validateCatalogExampleInput(toolName, input);
}

export function formatCatalogExampleInput(
  input: Readonly<Record<string, JsonValue>>,
  continuationIndent: number,
): string {
  return JSON.stringify(input, null, 2).replaceAll(
    "\n",
    `\n${" ".repeat(continuationIndent)}`,
  );
}

export const gmailSendEmailExampleInput =
  createCatalogExampleInput("gmail.send_email");

export const executionEmptySnippet =
  `await eyeball.tools.execute("gmail.send_email", {\n` +
  `  input: ${formatCatalogExampleInput(gmailSendEmailExampleInput, 2)}\n` +
  `});`;
