import type { QualifiedToolName, ToolDefinition } from "./types/tool.js";

export const CANONICAL_TOOL_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const RESTRICTED_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_CANONICAL_TOOL_NAME_LENGTH = 63;
export const MAX_RESTRICTED_TOOL_NAME_LENGTH = 64;

export interface ToolNameMap {
  canonicalToWire: Readonly<Record<QualifiedToolName, string>>;
  wireToCanonical: Readonly<Record<string, QualifiedToolName>>;
}

export function isCanonicalToolName(value: string): value is QualifiedToolName {
  return (
    value.length <= MAX_CANONICAL_TOOL_NAME_LENGTH &&
    CANONICAL_TOOL_NAME_PATTERN.test(value)
  );
}

export function validateCanonicalToolName(name: string): QualifiedToolName {
  if (!isCanonicalToolName(name)) {
    throw new Error(`Invalid canonical tool name: ${name}`);
  }
  return name;
}

export function toRestrictedToolName(name: QualifiedToolName): string {
  const canonical = validateCanonicalToolName(name);
  const dotIndex = canonical.indexOf(".");
  const wire = `${canonical.slice(0, dotIndex)}__${canonical.slice(dotIndex + 1)}`;
  if (
    wire.length > MAX_RESTRICTED_TOOL_NAME_LENGTH ||
    !RESTRICTED_TOOL_NAME_PATTERN.test(wire)
  ) {
    throw new Error(`Unportable tool name: ${name}`);
  }
  return wire;
}

export function fromRestrictedToolName(name: string): QualifiedToolName {
  if (!RESTRICTED_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Unknown tool name: ${name}`);
  }
  const parts = name.split("__");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error(`Unknown tool name: ${name}`);
  }
  const canonical = `${parts[0]}.${parts[1]}` as QualifiedToolName;
  if (toRestrictedToolName(canonical) !== name) {
    throw new Error(`Unknown tool name: ${name}`);
  }
  return canonical;
}

export function buildNameMap(
  tools: readonly Pick<ToolDefinition, "name">[],
): ToolNameMap {
  const canonicalToWire = new Map<QualifiedToolName, string>();
  const wireToCanonical = new Map<string, QualifiedToolName>();

  for (const tool of tools) {
    const canonical = validateCanonicalToolName(tool.name);
    const wire = toRestrictedToolName(canonical);

    if (canonicalToWire.has(canonical)) {
      throw new Error(`Canonical tool name collision: ${canonical}`);
    }
    const existingCanonical = wireToCanonical.get(wire);
    if (existingCanonical !== undefined) {
      throw new Error(
        `Restricted tool name collision: ${existingCanonical} and ${canonical} both map to ${wire}`,
      );
    }
    if (fromRestrictedToolName(wire) !== canonical) {
      throw new Error(`Non-reversible tool name: ${canonical}`);
    }

    canonicalToWire.set(canonical, wire);
    wireToCanonical.set(wire, canonical);
  }

  return {
    canonicalToWire: Object.freeze(
      Object.fromEntries(canonicalToWire) as Record<QualifiedToolName, string>,
    ),
    wireToCanonical: Object.freeze(
      Object.fromEntries(wireToCanonical) as Record<string, QualifiedToolName>,
    ),
  };
}
