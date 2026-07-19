import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  type ObjectSchema202012,
  type ToolDefinition,
  type TriggerDefinition,
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

interface CachedValidator {
  fingerprint: string;
  immutable: boolean;
  validator: ValidateFunction<unknown>;
}

const inputValidators = new WeakMap<ObjectSchema202012, CachedValidator>();
const outputValidators = new WeakMap<ObjectSchema202012, CachedValidator>();
const validatorsById = new Map<
  string,
  { fingerprint: string; validator: ValidateFunction<unknown> }
>();

function createCompiler(useDefaults: boolean): Ajv2020 {
  const compiler = new Ajv2020({
    allowUnionTypes: true,
    allErrors: true,
    strict: true,
    useDefaults,
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

function isDeeplyFrozen(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.values(value).every((child) => isDeeplyFrozen(child, seen));
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
  useDefaults: boolean,
): ValidateFunction<unknown> {
  const identityCache = useDefaults ? inputValidators : outputValidators;
  const cached = identityCache.get(schema);
  if (cached !== undefined) {
    if (!cached.immutable && cached.fingerprint !== schemaFingerprint(schema)) {
      throw new Error("Schema object changed after it was compiled.");
    }
    return cached.validator;
  }

  const fingerprint = schemaFingerprint(schema);
  const immutable = isDeeplyFrozen(schema);

  const idCacheKey =
    schema.$id === undefined
      ? undefined
      : `${useDefaults ? "input" : "output"}:${schema.$id}`;
  const identified =
    idCacheKey === undefined ? undefined : validatorsById.get(idCacheKey);
  if (identified !== undefined) {
    if (identified.fingerprint !== fingerprint) {
      throw new Error(
        `Schema $id ${schema.$id} is already registered with a different definition.`,
      );
    }
    identityCache.set(schema, { ...identified, immutable });
    return identified.validator;
  }

  // Ajv treats defensive copies that retain the same canonical $id as duplicate
  // registrations in one instance. Compile each unique schema identity in isolation,
  // then share the validator across structurally equivalent copies by $id.
  const compiled = createCompiler(useDefaults).compile(schema as AnySchema);
  const entry = { fingerprint, immutable, validator: compiled };
  identityCache.set(schema, entry);
  if (idCacheKey !== undefined) {
    validatorsById.set(idCacheKey, { fingerprint, validator: compiled });
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

function jsonValueIssue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): InputValidationIssue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : issue("type", "JSON numbers must be finite.", { instancePath: path });
  }
  if (typeof value !== "object") {
    return issue("type", "Value must contain only JSON data.", {
      instancePath: path,
    });
  }
  if (ancestors.has(value)) {
    return issue("type", "JSON values must not contain cycles.", {
      instancePath: path,
    });
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const childIssue = jsonValueIssue(
          value[index],
          `${path}/${index}`,
          ancestors,
        );
        if (childIssue !== undefined) return childIssue;
      }
      return undefined;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return issue(
        "type",
        "JSON objects must be plain objects, not class instances or collection types.",
        { instancePath: path },
      );
    }
    for (const [key, child] of Object.entries(value)) {
      const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const childIssue = jsonValueIssue(
        child,
        `${path}/${escapedKey}`,
        ancestors,
      );
      if (childIssue !== undefined) return childIssue;
    }
    return undefined;
  } catch {
    return issue("type", "Value could not be inspected as JSON data.", {
      instancePath: path,
    });
  } finally {
    ancestors.delete(value);
  }
}

function validateObject(
  schema: ObjectSchema202012,
  input: unknown,
  options: { useDefaults: boolean; noun: "Input" | "Output" | "Payload" },
): InputValidationResult {
  const profileError = schemaProfileIssue(schema);
  if (profileError !== undefined) {
    return { ok: false, errors: [profileError] };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      errors: [issue("type", `${options.noun} must be an object.`)],
    };
  }
  const inputJsonIssue = jsonValueIssue(input, "", new WeakSet());
  if (inputJsonIssue !== undefined) {
    return { ok: false, errors: [inputJsonIssue] };
  }

  let value: Record<string, JsonValue>;
  try {
    value = structuredClone(input) as Record<string, JsonValue>;
  } catch {
    return {
      ok: false,
      errors: [issue("type", "Value could not be cloned as JSON data.")],
    };
  }
  let validator: ValidateFunction<unknown>;
  try {
    validator = compileValidator(schema, options.useDefaults);
  } catch (error) {
    return {
      ok: false,
      errors: [
        issue(
          "schema_profile",
          error instanceof Error
            ? error.message
            : `Tool ${options.noun.toLowerCase()} schema is invalid.`,
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
  const defaultedJsonIssue = jsonValueIssue(value, "", new WeakSet());
  return defaultedJsonIssue === undefined
    ? { ok: true, value }
    : { ok: false, errors: [defaultedJsonIssue] };
}

/**
 * Validates and defaults canonical input without mutating the caller's object.
 * Supported JSON Schema formats are assertions through `ajv-formats`.
 */
export function validateInput(
  tool: Pick<ToolDefinition, "inputSchema">,
  input: unknown,
): InputValidationResult {
  return validateObject(tool.inputSchema, input, {
    useDefaults: true,
    noun: "Input",
  });
}

/** Validates canonical adapter output without applying JSON Schema defaults. */
export function validateOutput(
  tool: Pick<ToolDefinition, "outputSchema">,
  output: unknown,
): InputValidationResult {
  if (tool.outputSchema === undefined) {
    return {
      ok: false,
      errors: [issue("schema_profile", "Tool output schema is missing.")],
    };
  }
  return validateObject(tool.outputSchema, output, {
    useDefaults: false,
    noun: "Output",
  });
}

/** Validates a normalized provider event against its materialized trigger schema. */
export function validateTriggerPayload(
  trigger: Pick<TriggerDefinition, "payloadSchema">,
  payload: unknown,
): InputValidationResult {
  return validateObject(trigger.payloadSchema, payload, {
    useDefaults: false,
    noun: "Payload",
  });
}
