import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { ToolDefinition } from "../types/tool.js";
import {
  immutableDefinitions,
  type MutableObjectSchema,
  mutableObjectSchema,
  toolDescription,
  wireNameFor,
} from "./shared.js";

export interface OpenAIFunctionDescriptor {
  name: string;
  description: string;
  parameters: MutableObjectSchema;
  strict?: boolean;
}

export interface OpenAIFunctionToolDescriptor {
  type: "function";
  function: OpenAIFunctionDescriptor;
}

export interface OpenAIToolsConversion {
  tools: OpenAIFunctionToolDescriptor[];
  nameMap: ToolNameMap;
  definitions: readonly ToolDefinition[];
}

/**
 * Converts canonical definitions without enabling OpenAI strict mode. Strict mode
 * requires a version-pinned compatibility validator, which core does not provide.
 */
export function toOpenAITools(
  tools: readonly ToolDefinition[],
): OpenAIToolsConversion {
  const nameMap = buildNameMap(tools);

  return {
    tools: tools.map((tool) => ({
      type: "function",
      function: {
        name: wireNameFor(nameMap, tool.name),
        description: toolDescription(tool),
        parameters: mutableObjectSchema(tool.inputSchema),
      },
    })),
    nameMap,
    definitions: immutableDefinitions(tools),
  };
}
