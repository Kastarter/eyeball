import type { ToolNameMap } from "../naming.js";
import type { QualifiedToolName, ToolDefinition } from "../types/tool.js";

export function wireNameFor(
  nameMap: ToolNameMap,
  canonicalName: QualifiedToolName,
): string {
  const wireName = nameMap.canonicalToWire[canonicalName];
  if (wireName === undefined) {
    throw new Error(`Missing wire name for canonical tool: ${canonicalName}`);
  }
  return wireName;
}

export function toolDescription(
  tool: Pick<ToolDefinition, "annotations" | "description" | "name">,
  includeAnnotationHints = false,
): string {
  const description = tool.description.trim();
  if (description.length === 0) {
    throw new Error(`Tool description must not be empty: ${tool.name}`);
  }

  if (!includeAnnotationHints) {
    return description;
  }

  const hints: string[] = [];
  if (tool.annotations.readOnly) {
    hints.push("Read-only: does not change external state.");
  }
  if (tool.annotations.destructive) {
    hints.push(
      "Destructive: may delete, overwrite, debit, revoke, or otherwise cause loss.",
    );
  }
  if (tool.annotations.idempotent) {
    hints.push(
      "Idempotent: repeating the provider operation has no additional effect.",
    );
  }
  if (tool.annotations.async) {
    hints.push("Async: this operation must be executed asynchronously.");
  }

  return hints.length === 0
    ? description
    : `${description}\n\n${hints.join(" ")}`;
}
