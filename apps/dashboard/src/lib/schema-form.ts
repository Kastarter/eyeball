import type { CatalogJsonPrimitive, CatalogSchema } from "@/src/lib/catalog";

export type SchemaFieldKind =
  | "attachments"
  | "boolean"
  | "enum"
  | "json"
  | "number"
  | "string";

export interface SchemaFormField {
  defaultValue?: unknown;
  description?: string;
  enumValues?: readonly CatalogJsonPrimitive[];
  format?: string;
  kind: SchemaFieldKind;
  label: string;
  name: string;
  required: boolean;
}

export type SchemaFormValues = Readonly<
  Record<string, boolean | string | undefined>
>;

export interface SchemaFormResult {
  errors: Readonly<Record<string, string>>;
  value: Readonly<Record<string, unknown>>;
}

function humanize(name: string): string {
  const words = name.replaceAll(/[_-]+/gu, " ").trim();
  return words.length === 0
    ? name
    : `${words[0]?.toUpperCase()}${words.slice(1)}`;
}

function requiresFileId(schema: CatalogSchema | undefined): boolean {
  if (schema === undefined || typeof schema === "boolean") return false;
  if (schema.required?.includes("fileId")) return true;
  const anyOf = schema.anyOf;
  return (
    Array.isArray(anyOf) &&
    anyOf.some((candidate) => requiresFileId(candidate as CatalogSchema))
  );
}

/** Arrays of staged-file references get the dedicated Try-It attachment picker. */
export function isStagedAttachmentArray(schema: CatalogSchema): boolean {
  if (typeof schema === "boolean") return false;
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  return type === "array" && requiresFileId(schema.items);
}

function fieldKind(schema: CatalogSchema): SchemaFieldKind {
  if (typeof schema === "boolean") return "json";
  if (schema.enum !== undefined) return "enum";
  if (isStagedAttachmentArray(schema)) return "attachments";
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

export function buildSchemaFormFields(
  schema: CatalogSchema,
): readonly SchemaFormField[] {
  if (
    typeof schema === "boolean" ||
    schema.type !== "object" ||
    schema.properties === undefined
  ) {
    return [];
  }
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, property]) => {
    const objectProperty = typeof property === "boolean" ? undefined : property;
    return {
      ...(objectProperty?.default === undefined
        ? {}
        : { defaultValue: objectProperty.default }),
      ...(objectProperty?.description === undefined
        ? {}
        : { description: objectProperty.description }),
      ...(objectProperty?.enum === undefined
        ? {}
        : { enumValues: objectProperty.enum }),
      ...(objectProperty?.format === undefined
        ? {}
        : { format: objectProperty.format }),
      kind: fieldKind(property),
      label: objectProperty?.title ?? humanize(name),
      name,
      required: required.has(name),
    };
  });
}

export function initialSchemaFormValues(
  fields: readonly SchemaFormField[],
): Record<string, boolean | string> {
  return Object.fromEntries(
    fields.map((field) => {
      if (field.defaultValue !== undefined) {
        if (field.kind === "boolean") {
          return [field.name, Boolean(field.defaultValue)];
        }
        if (field.kind === "json") {
          return [field.name, JSON.stringify(field.defaultValue, null, 2)];
        }
        return [field.name, String(field.defaultValue)];
      }
      return [field.name, field.kind === "boolean" ? false : ""];
    }),
  );
}

export function coerceSchemaFormValues(
  fields: readonly SchemaFormField[],
  values: SchemaFormValues,
): SchemaFormResult {
  const errors: Record<string, string> = {};
  const value: Record<string, unknown> = {};

  for (const field of fields) {
    const rawValue = values[field.name];
    if (
      field.kind !== "boolean" &&
      (rawValue === "" || rawValue === undefined)
    ) {
      if (field.required) errors[field.name] = "This field is required.";
      continue;
    }

    if (field.kind === "boolean") {
      value[field.name] = Boolean(rawValue);
      continue;
    }
    const raw = String(rawValue);
    if (field.kind === "string") {
      value[field.name] = raw;
      continue;
    }
    if (field.kind === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        errors[field.name] = "Enter a valid number.";
      } else {
        value[field.name] = parsed;
      }
      continue;
    }
    if (field.kind === "enum") {
      const option = field.enumValues?.find(
        (candidate) => String(candidate) === raw,
      );
      if (option === undefined) {
        errors[field.name] = "Choose one of the allowed values.";
      } else {
        value[field.name] = option;
      }
      continue;
    }
    if (field.kind === "attachments") {
      const fileIds = raw
        .split(",")
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate.length > 0);
      if (
        fileIds.some(
          (fileId) => !/^file_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(fileId),
        )
      ) {
        errors[field.name] = "Attachments must be staged file_* identifiers.";
      } else if (fileIds.length > 0) {
        value[field.name] = fileIds.map((fileId) => ({ fileId }));
      }
      continue;
    }

    try {
      value[field.name] = JSON.parse(raw) as unknown;
    } catch {
      errors[field.name] = "Enter valid JSON.";
    }
  }

  return { errors, value };
}
