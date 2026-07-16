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

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

export function acceptedRecipients(
  input: Readonly<Record<string, unknown>>,
): string[] {
  return unique([
    ...stringArrayValue(input, "to"),
    ...stringArrayValue(input, "cc"),
    ...stringArrayValue(input, "bcc"),
  ]);
}

export function providerOptions(
  context: AdapterContext,
  toolkitSlug: string,
): Readonly<Record<string, unknown>> {
  const extensions = context.canonicalInput.x_provider;
  if (!isRecord(extensions)) {
    return {};
  }
  const options = extensions[toolkitSlug];
  return isRecord(options) ? options : {};
}

function credentialOption(
  context: AdapterContext,
  key: string,
): string | undefined {
  if (context.credential.type === "api_key") {
    return context.credential.values[key];
  }
  if (context.credential.type === "basic") {
    return context.credential.parameters?.[key];
  }
  return undefined;
}

export function requiredProviderString(
  context: AdapterContext,
  toolkitSlug: string,
  key: string,
): string {
  const value =
    stringValue(providerOptions(context, toolkitSlug), key) ??
    credentialOption(context, key);
  if (value === undefined || value.trim().length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name} requires x_provider.${toolkitSlug}.${key}.`,
    });
  }
  return value;
}

export function optionalProviderString(
  context: AdapterContext,
  toolkitSlug: string,
  key: string,
): string | undefined {
  return (
    stringValue(providerOptions(context, toolkitSlug), key) ??
    credentialOption(context, key)
  );
}

export function assertNoAttachments(context: AdapterContext): void {
  const attachments = context.canonicalInput.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message:
        "Staged email attachments require a file-content resolver that is not available to this adapter runtime.",
    });
  }
}

export function jsonRequest(
  body: unknown,
  method: "POST" | "PATCH" = "POST",
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
): EyeballError {
  return new EyeballError({
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
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

export function unsupportedTool(context: AdapterContext): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message: `${context.tool.toolkit} does not implement ${context.tool.name}.`,
  });
}

export function bodyPayload(input: Readonly<Record<string, unknown>>): {
  html?: string;
  text?: string;
} {
  const body = stringValue(input, "body") ?? "";
  return stringValue(input, "bodyFormat") === "html"
    ? { html: body }
    : { text: body };
}

export function addressFromHeader(value: string): string {
  const match = /<([^<>]+)>/u.exec(value);
  return (match?.[1] ?? value).trim();
}

export function splitAddresses(value: string): string[] {
  return unique(
    value
      .split(",")
      .map(addressFromHeader)
      .filter((address) => address.length > 0),
  );
}

export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}
