import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";

export function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

export function booleanValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

export function numberValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const field = value[key];
  if (typeof field === "number" && Number.isFinite(field)) return field;
  if (typeof field === "string" && field.trim().length > 0) {
    const parsed = Number(field);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function idValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function requiredId(
  context: AdapterContext,
  value: unknown,
  field: string,
): string {
  const id = idValue(value);
  if (id === undefined) {
    throw providerError(
      context,
      `The provider response omitted the required ${field} identifier.`,
    );
  }
  return id;
}

export function requiredString(
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

export function inputString(context: AdapterContext, key: string): string {
  const value = stringValue(context.canonicalInput, key);
  if (value === undefined || value.trim().length === 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: ${key} is required.`,
    });
  }
  return value;
}

export function recordValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

export function providerExtension(
  context: AdapterContext,
): Readonly<Record<string, unknown>> {
  const providers = recordValue(context.canonicalInput, "x_provider");
  const extension =
    providers === undefined
      ? undefined
      : recordValue(providers, context.tool.toolkit);
  if (extension === undefined) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: x_provider.${context.tool.toolkit} is required.`,
    });
  }
  return extension;
}

export function providerError(
  context: AdapterContext,
  message: string,
  options: { code?: string; detail?: JsonValue } = {},
): EyeballError {
  return new EyeballError({
    code: TOOL_ERROR_CODES.PROVIDER_ERROR,
    message,
    providerDetail: {
      toolkit: context.tool.toolkit,
      ...(options.code === undefined ? {} : { code: options.code }),
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    },
  });
}

export function unsupported(context: AdapterContext, message?: string): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.NOT_SUPPORTED,
    message:
      message ??
      `${context.tool.toolkit} does not implement ${context.tool.name}.`,
  });
}

export function asJson(value: unknown): JsonValue {
  return value as JsonValue;
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

export function formRequest(
  values: Readonly<Record<string, string>>,
  method: "POST" | "DELETE" = "POST",
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  };
}

export async function jsonObject(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await createProviderHttpClient(context)(path, init);
  const value: unknown = await response.json();
  if (!isRecord(value)) {
    throw providerError(
      context,
      "The provider returned an invalid JSON object.",
    );
  }
  return value;
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

export function isoFromUnix(
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

export function parseOffsetToken(
  context: AdapterContext,
  token: string | undefined,
): number {
  if (token === undefined) return 0;
  const match = /^offset:(\d+)$/u.exec(token);
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: pageToken is invalid.`,
    });
  }
  return offset;
}

export function page<T>(
  values: readonly T[],
  offset: number,
  pageSize: number,
): { values: readonly T[]; nextPageToken?: string } {
  const selected = values.slice(offset, offset + pageSize);
  const nextOffset = offset + selected.length;
  return {
    values: selected,
    ...(nextOffset < values.length
      ? { nextPageToken: `offset:${nextOffset}` }
      : {}),
  };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function finiteNumber(
  context: AdapterContext,
  value: unknown,
  field: string,
  fallback?: number,
): number {
  const parsed =
    typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (fallback !== undefined) return fallback;
  throw providerError(
    context,
    `The provider returned an invalid ${field} number.`,
  );
}
