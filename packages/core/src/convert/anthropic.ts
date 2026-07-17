import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { ToolDefinition } from "../types/tool.js";
import {
  immutableDefinitions,
  type MutableObjectSchema,
  mutableObjectSchema,
  toolDescription,
  wireNameFor,
} from "./shared.js";

export interface AnthropicToolDescriptor {
  name: string;
  description: string;
  input_schema: MutableObjectSchema;
}

export interface AnthropicToolsConversion {
  tools: AnthropicToolDescriptor[];
  nameMap: ToolNameMap;
  definitions: readonly ToolDefinition[];
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
      input_schema: mutableObjectSchema(tool.inputSchema),
    })),
    nameMap,
    definitions: immutableDefinitions(tools),
  };
}
