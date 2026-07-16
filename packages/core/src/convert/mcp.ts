import { buildNameMap } from "../naming.js";
import type {
  ObjectSchema202012,
  QualifiedToolName,
  ToolDefinition,
} from "../types/tool.js";
import { toolDescription } from "./shared.js";

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
  inputSchema: ObjectSchema202012;
  outputSchema?: ObjectSchema202012;
  annotations: McpToolAnnotations;
  /** Present only when the MCP Tasks protocol has been negotiated. */
  execution?: McpToolExecution;
}

export interface McpConversionOptions {
  /** Include async tools for an MCP Tasks-capable session. */
  includeAsync?: boolean;
}

export function toMcpTools(
  tools: readonly ToolDefinition[],
  options: McpConversionOptions = {},
): McpToolDescriptor[] {
  // MCP preserves dotted names, but catalog-level naming and collision checks
  // remain format-independent.
  buildNameMap(tools);

  const includeAsync = options.includeAsync ?? false;

  return tools
    .filter((tool) => includeAsync || !tool.annotations.async)
    .map((tool) => ({
      name: tool.name,
      description: toolDescription(tool),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: tool.outputSchema }),
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
    }));
}
