import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  type ObjectSchema202012,
  type ToolDefinition,
} from "./types/tool.js";

export interface InputValidationIssue {
  code: "invalid_input";
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Readonly<Record<string, unknown>>;
}

export interface InputValidationSuccess {
  ok: true;
  /** A cloned, defaulted, and validated canonical input value. */
  value: Readonly<Record<string, JsonValue>>;
}

export interface InputValidationFailure {
  ok: false;
  errors: readonly InputValidationIssue[];
}

export type InputValidationResult =
  | InputValidationSuccess
  | InputValidationFailure;

const ajv = new Ajv2020({
  allowUnionTypes: true,
  allErrors: true,
  strict: true,
  useDefaults: true,
  validateFormats: true,
});

addFormats(ajv);

const validators = new WeakMap<ObjectSchema202012, ValidateFunction<unknown>>();

function issue(
  keyword: string,
  message: string,
  options: {
    instancePath?: string;
    schemaPath?: string;
    params?: Readonly<Record<string, unknown>>;
  } = {},
): InputValidationIssue {
  return {
    code: "invalid_input",
    instancePath: options.instancePath ?? "",
    schemaPath: options.schemaPath ?? "",
    keyword,
    message,
    params: options.params ?? {},
  };
}

function schemaProfileIssue(
  schema: ObjectSchema202012,
): InputValidationIssue | undefined {
  if (schema.type !== "object") {
    return issue(
      "schema_profile",
      "Tool input schema must have an object root.",
    );
  }
  if (schema.$schema !== JSON_SCHEMA_DRAFT_2020_12) {
    return issue(
      "schema_profile",
      `Tool input schema must declare ${JSON_SCHEMA_DRAFT_2020_12}.`,
    );
  }
  return undefined;
}

function compileValidator(
  schema: ObjectSchema202012,
): ValidateFunction<unknown> {
  const cached = validators.get(schema);
  if (cached !== undefined) {
    return cached;
  }

  const compiled = ajv.compile(schema as AnySchema);
  validators.set(schema, compiled);
  return compiled;
}

function fromAjvError(error: ErrorObject): InputValidationIssue {
  return issue(error.keyword, error.message ?? "Input is invalid.", {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    params: error.params,
  });
}

function isObjectInput(
  input: unknown,
): input is Readonly<Record<string, JsonValue>> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Validates and defaults canonical input without mutating the caller's object.
 * Supported JSON Schema formats are assertions through `ajv-formats`.
 */
export function validateInput(
  tool: Pick<ToolDefinition, "inputSchema">,
  input: unknown,
): InputValidationResult {
  const profileError = schemaProfileIssue(tool.inputSchema);
  if (profileError !== undefined) {
    return { ok: false, errors: [profileError] };
  }

  if (!isObjectInput(input)) {
    return {
      ok: false,
      errors: [issue("type", "Input must be an object.")],
    };
  }

  let value: Record<string, JsonValue>;
  try {
    value = structuredClone(input) as Record<string, JsonValue>;
  } catch {
    return {
      ok: false,
      errors: [
        issue(
          "type",
          "Input must contain only structured-cloneable JSON values.",
        ),
      ],
    };
  }
  let validator: ValidateFunction<unknown>;
  try {
    validator = compileValidator(tool.inputSchema);
  } catch (error) {
    return {
      ok: false,
      errors: [
        issue(
          "schema_profile",
          error instanceof Error
            ? error.message
            : "Tool input schema is invalid.",
        ),
      ],
    };
  }

  if (!validator(value)) {
    return {
      ok: false,
      errors: (validator.errors ?? []).map(fromAjvError),
    };
  }

  return { ok: true, value };
}
