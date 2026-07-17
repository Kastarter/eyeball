import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { QualifiedToolName, ToolDefinition } from "../types/tool.js";
import {
  immutableDefinitions,
  type MutableObjectSchema,
  mutableObjectSchema,
  toolDescription,
} from "./shared.js";

export interface McpToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface McpToolExecution {
  taskSupport: "optional" | "required";
}

export interface McpToolDescriptor {
  name: QualifiedToolName;
  description: string;
  inputSchema: MutableObjectSchema;
  outputSchema?: MutableObjectSchema;
  annotations: McpToolAnnotations;
  /** Present only when the MCP Tasks protocol has been negotiated. */
  execution?: McpToolExecution;
}

export interface McpConversionOptions {
  /** Include async tools for an MCP Tasks-capable session. */
  includeAsync?: boolean;
}

export interface McpToolsConversion {
  tools: McpToolDescriptor[];
  nameMap: ToolNameMap;
  definitions: readonly ToolDefinition[];
}

export function toMcpTools(
  tools: readonly ToolDefinition[],
  options: McpConversionOptions = {},
): McpToolsConversion {
  // MCP preserves dotted names, but catalog-level naming and collision checks
  // remain format-independent.
  const includeAsync = options.includeAsync ?? false;
  const selected = tools.filter(
    (tool) => includeAsync || !tool.annotations.async,
  );
  // Run the shared validation/collision checks, then expose an identity map because
  // MCP emits the canonical dotted names themselves rather than restricted names.
  buildNameMap(selected);
  const identityEntries = selected.map(
    (tool) => [tool.name, tool.name] as const,
  );
  const nameMap: ToolNameMap = {
    canonicalToWire: Object.freeze(Object.fromEntries(identityEntries)),
    wireToCanonical: Object.freeze(Object.fromEntries(identityEntries)),
  };

  return {
    tools: selected.map((tool) => ({
      name: tool.name,
      description: toolDescription(tool),
      inputSchema: mutableObjectSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: mutableObjectSchema(tool.outputSchema) }),
      annotations: {
        readOnlyHint: tool.annotations.readOnly,
        destructiveHint: tool.annotations.destructive,
        idempotentHint: tool.annotations.idempotent,
      },
      ...(includeAsync
        ? {
            execution: {
              taskSupport: tool.annotations.async ? "required" : "optional",
            } satisfies McpToolExecution,
          }
        : {}),
    })),
    nameMap,
    definitions: immutableDefinitions(selected),
  };
}
