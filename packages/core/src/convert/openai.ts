import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { ObjectSchema202012, ToolDefinition } from "../types/tool.js";
import { toolDescription, wireNameFor } from "./shared.js";

export interface OpenAIFunctionDescriptor {
  name: string;
  description: string;
  parameters: ObjectSchema202012;
  strict?: boolean;
}

export interface OpenAIFunctionToolDescriptor {
  type: "function";
  function: OpenAIFunctionDescriptor;
}

export interface OpenAIToolsConversion {
  tools: OpenAIFunctionToolDescriptor[];
  nameMap: ToolNameMap;
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
        parameters: tool.inputSchema,
      },
    })),
    nameMap,
  };
}
