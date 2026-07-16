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

const validators = new WeakMap<ObjectSchema202012, ValidateFunction<unknown>>();
const validatorsById = new Map<
  string,
  { fingerprint: string; validator: ValidateFunction<unknown> }
>();

function createCompiler(): Ajv2020 {
  const compiler = new Ajv2020({
    allowUnionTypes: true,
    allErrors: true,
    strict: true,
    useDefaults: true,
    validateFormats: true,
  });
  addFormats(compiler);
  return compiler;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function schemaFingerprint(schema: ObjectSchema202012): string {
  return JSON.stringify(canonicalize(schema));
}

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

  const fingerprint =
    schema.$id === undefined ? undefined : schemaFingerprint(schema);
  const identified =
    schema.$id === undefined ? undefined : validatorsById.get(schema.$id);
  if (identified !== undefined) {
    if (identified.fingerprint !== fingerprint) {
      throw new Error(
        `Schema $id ${schema.$id} is already registered with a different definition.`,
      );
    }
    validators.set(schema, identified.validator);
    return identified.validator;
  }

  // Ajv treats defensive copies that retain the same canonical $id as duplicate
  // registrations in one instance. Compile each unique schema identity in isolation,
  // then share the validator across structurally equivalent copies by $id.
  const compiled = createCompiler().compile(schema as AnySchema);
  validators.set(schema, compiled);
  if (schema.$id !== undefined && fingerprint !== undefined) {
    validatorsById.set(schema.$id, { fingerprint, validator: compiled });
  }
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
