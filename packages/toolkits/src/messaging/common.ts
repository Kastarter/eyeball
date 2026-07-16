import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
} from "@eyeball/core";

export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export function booleanValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function numberValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

export function stringArrayValue(
  input: Readonly<Record<string, unknown>>,
  key: string,
): string[] {
  const value = input[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function idString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function records(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function jsonRequest(
  body: unknown,
  method: "POST" | "PATCH" | "PUT" = "POST",
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function providerError(
  context: AdapterContext,
  message: string,
  code?: string,
): EyeballError {
  return new EyeballError({
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message,
    providerDetail: {
      toolkit: context.tool.toolkit,
      ...(code === undefined ? {} : { code }),
    },
  });
}

export function invalidInput(context: AdapterContext, message: string): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.INVALID_INPUT,
    message: `${context.tool.name}: ${message}`,
  });
}

export function notFound(context: AdapterContext, message: string): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.NOT_FOUND,
    message,
    providerDetail: { toolkit: context.tool.toolkit },
  });
}

export async function jsonObject(
  context: AdapterContext,
  response: Response,
): Promise<Readonly<Record<string, unknown>>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw providerError(
      context,
      "The provider returned an invalid JSON object.",
    );
  }
  return value;
}

export function requiredRecordField(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const field = value[key];
  if (!isRecord(field)) {
    throw providerError(
      context,
      `The provider response omitted the required ${key} object.`,
    );
  }
  return field;
}

export function requiredStringField(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const field = stringValue(value, key);
  if (field === undefined || field.length === 0) {
    throw providerError(
      context,
      `The provider response omitted the required ${key} field.`,
    );
  }
  return field;
}

export function requiredIdField(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const field = idString(value[key]);
  if (field === undefined) {
    throw providerError(
      context,
      `The provider response omitted the required ${key} field.`,
    );
  }
  return field;
}

export function requiredInputString(
  context: AdapterContext,
  key: string,
): string {
  const value = stringValue(context.canonicalInput, key);
  if (value === undefined || value.trim().length === 0) {
    return invalidInput(context, `${key} is required for this provider.`);
  }
  return value;
}

export function requiredApiKeyValue(
  context: AdapterContext,
  key: string,
): string {
  const value =
    context.credential.type === "api_key"
      ? context.credential.values[key]
      : undefined;
  if (value === undefined || value.trim().length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: `${context.tool.toolkit} requires credential field ${key}.`,
    });
  }
  return value;
}

export function isoFromUnixSeconds(
  context: AdapterContext,
  value: unknown,
  field: string,
): string {
  const seconds =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(seconds) || Number.isNaN(date.valueOf())) {
    throw providerError(
      context,
      `The provider returned an invalid ${field} timestamp.`,
    );
  }
  return date.toISOString();
}

export function isoString(
  context: AdapterContext,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw providerError(
      context,
      `The provider returned an invalid ${field} timestamp.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw providerError(
      context,
      `The provider returned an invalid ${field} timestamp.`,
    );
  }
  return date.toISOString();
}

export function assertNoAttachments(context: AdapterContext): void {
  const attachments = context.canonicalInput.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message:
        "Staged messaging attachments require a file-content resolver that is not available to this adapter runtime.",
    });
  }
}

export function unsupportedTool(context: AdapterContext): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message: `${context.tool.toolkit} does not implement ${context.tool.name}.`,
  });
}

export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
