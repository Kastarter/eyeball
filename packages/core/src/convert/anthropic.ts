import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { ObjectSchema202012, ToolDefinition } from "../types/tool.js";
import { toolDescription, wireNameFor } from "./shared.js";

export interface AnthropicToolDescriptor {
  name: string;
  description: string;
  input_schema: ObjectSchema202012;
}

export interface AnthropicToolsConversion {
  tools: AnthropicToolDescriptor[];
  nameMap: ToolNameMap;
}

export interface AnthropicConversionOptions {
  /** Append trusted annotation hints to the model-facing description. */
  includeAnnotationHints?: boolean;
}

export function toAnthropicTools(
  tools: readonly ToolDefinition[],
  options: AnthropicConversionOptions = {},
): AnthropicToolsConversion {
  const nameMap = buildNameMap(tools);

  return {
    tools: tools.map((tool) => ({
      name: wireNameFor(nameMap, tool.name),
      description: toolDescription(tool, options.includeAnnotationHints),
      input_schema: tool.inputSchema,
    })),
    nameMap,
  };
}
