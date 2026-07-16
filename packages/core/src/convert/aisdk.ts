import { buildNameMap } from "../naming.js";
import type {
  JsonValue,
  ObjectSchema202012,
  ToolDefinition,
} from "../types/tool.js";
import { toolDescription, wireNameFor } from "./shared.js";

export type AiSdkExecute = (
  wireName: string,
  input: unknown,
) => Promise<JsonValue>;

export interface AiSdkToolDescriptor {
  description: string;
  /** Plain JSON Schema object for the AI SDK's jsonSchema() wrapper. */
  inputSchema: ObjectSchema202012;
  execute?: (input: unknown) => Promise<JsonValue>;
}

export type AiSdkToolSet = Record<string, AiSdkToolDescriptor>;

export function toAiSdkTools(
  tools: readonly ToolDefinition[],
  execute?: AiSdkExecute,
): AiSdkToolSet {
  const nameMap = buildNameMap(tools);

  return Object.fromEntries(
    tools.map((tool) => {
      const wireName = wireNameFor(nameMap, tool.name);
      const descriptor: AiSdkToolDescriptor =
        execute === undefined
          ? {
              description: toolDescription(tool),
              inputSchema: tool.inputSchema,
            }
          : {
              description: toolDescription(tool),
              inputSchema: tool.inputSchema,
              execute: (input) => execute(wireName, input),
            };

      return [wireName, descriptor];
    }),
  );
}
