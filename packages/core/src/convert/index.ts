import type { ToolDefinition } from "../types/tool.js";
import { type AiSdkToolSet, toAiSdkTools } from "./aisdk.js";
import {
  type AnthropicToolsConversion,
  toAnthropicTools,
} from "./anthropic.js";
import { type McpToolDescriptor, toMcpTools } from "./mcp.js";
import { type OpenAIToolsConversion, toOpenAITools } from "./openai.js";

export * from "./aisdk.js";
export * from "./anthropic.js";
export * from "./mcp.js";
export * from "./openai.js";

export type ToolFormat = "anthropic" | "openai" | "ai-sdk" | "mcp";

export interface ToolFormatConversionMap {
  anthropic: AnthropicToolsConversion;
  openai: OpenAIToolsConversion;
  "ai-sdk": AiSdkToolSet;
  mcp: McpToolDescriptor[];
}

export type ToolFormatConversion = ToolFormatConversionMap[ToolFormat];

export function convert<Format extends ToolFormat>(
  tools: readonly ToolDefinition[],
  format: Format,
): ToolFormatConversionMap[Format];
export function convert(
  tools: readonly ToolDefinition[],
  format: ToolFormat,
): ToolFormatConversion {
  switch (format) {
    case "anthropic":
      return toAnthropicTools(tools);
    case "openai":
      return toOpenAITools(tools);
    case "ai-sdk":
      return toAiSdkTools(tools);
    case "mcp":
      return toMcpTools(tools);
  }
}
