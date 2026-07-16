import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";

export {
  asJson,
  booleanValue,
  finiteNumber,
  idValue,
  inputString,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  page,
  parseOffsetToken,
  providerError,
  records,
  recordValue,
  requiredId,
  requiredString,
  stringArray,
  stringValue,
  unsupported,
} from "../business/common.js";

export function inputRecord(
  context: AdapterContext,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = context.canonicalInput[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: ${key} must be an object.`,
    });
  }
  return value as Readonly<Record<string, unknown>>;
}

export function inputArray(
  context: AdapterContext,
  key: string,
): readonly JsonValue[] {
  const value = context.canonicalInput[key];
  if (!Array.isArray(value)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: ${key} must be an array.`,
    });
  }
  return value;
}

export function queryPath(
  path: string,
  values: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const serialized = query.toString();
  return serialized.length === 0 ? path : `${path}?${serialized}`;
}

export async function responseText(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<{ content: string; contentType?: string }> {
  const response = await createProviderHttpClient(context)(path, init);
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    content: await response.text(),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

export async function jsonRecords(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>[]> {
  const response = await createProviderHttpClient(context)(path, init);
  const value: unknown = await response.json();
  if (!Array.isArray(value)) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "The provider returned an invalid JSON array.",
      providerDetail: { toolkit: context.tool.toolkit },
    });
  }
  return value.filter(
    (entry): entry is Readonly<Record<string, unknown>> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

export async function responseVoid(
  context: AdapterContext,
  path: string,
  init: RequestInit,
): Promise<void> {
  await createProviderHttpClient(context)(path, init);
}

export function includesValue(value: unknown, query: string): boolean {
  const needle = query.toLowerCase();
  const visit = (entry: unknown): boolean => {
    if (typeof entry === "string" || typeof entry === "number") {
      return String(entry).toLowerCase().includes(needle);
    }
    if (Array.isArray(entry)) return entry.some(visit);
    if (typeof entry === "object" && entry !== null) {
      return Object.values(entry).some(visit);
    }
    return false;
  };
  return visit(value);
}
