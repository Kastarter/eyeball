import type { Context } from "hono";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(
  context: Context,
): Promise<Record<string, unknown>> {
  const value: unknown = await context.req.json();
  if (!isObject(value)) {
    throw new Error("The request body must be a JSON object.");
  }
  return value;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

type Cursor = {
  scope: string;
  offset: number;
};

export interface CursorPage<T> {
  items: T[];
  nextCursor: string;
}

function decodeCursor(value: string, scope: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("cursor is invalid.");
  }
  if (
    !isObject(decoded) ||
    decoded.scope !== scope ||
    !Number.isSafeInteger(decoded.offset) ||
    (decoded.offset as number) < 0
  ) {
    throw new Error("cursor is invalid for this resource.");
  }
  return decoded.offset as number;
}

export function cursorPage<T>(options: {
  items: readonly T[];
  scope: string;
  cursor: string | null;
  limit: string | null;
  defaultLimit?: number;
  maxLimit?: number;
}): CursorPage<T> {
  const defaultLimit = options.defaultLimit ?? 100;
  const maxLimit = options.maxLimit ?? 200;
  const limit = options.limit === null ? defaultLimit : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new Error(`limit must be an integer from 1 to ${maxLimit}.`);
  }
  const offset =
    options.cursor === null || options.cursor.length === 0
      ? 0
      : decodeCursor(options.cursor, options.scope);
  if (offset > options.items.length) {
    throw new Error("cursor points beyond the available results.");
  }
  const items = options.items.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const next: Cursor = { scope: options.scope, offset: nextOffset };
  return {
    items,
    nextCursor:
      nextOffset < options.items.length
        ? Buffer.from(JSON.stringify(next), "utf8").toString("base64url")
        : "",
  };
}

export function validIso(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return value;
}
