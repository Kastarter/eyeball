import { jsonSchema, type Schema } from "@ai-sdk/provider-utils";
import { buildNameMap, type ToolNameMap } from "../naming.js";
import type { JsonValue, ToolDefinition } from "../types/tool.js";
import {
  immutableDefinitions,
  mutableObjectSchema,
  toolDescription,
  wireNameFor,
} from "./shared.js";

export type AiSdkExecute = (
  wireName: string,
  input: unknown,
) => Promise<JsonValue>;

export interface AiSdkToolDescriptor {
  description: string;
  /** AI SDK-native schema wrapper, ready for direct use in a ToolSet. */
  inputSchema: Schema<unknown>;
  execute?: (input: unknown) => Promise<JsonValue>;
}

export type AiSdkToolSet = Record<string, AiSdkToolDescriptor>;

export interface AiSdkToolsConversion {
  tools: AiSdkToolSet;
  nameMap: ToolNameMap;
  definitions: readonly ToolDefinition[];
}

export function toAiSdkTools(
  tools: readonly ToolDefinition[],
  execute?: AiSdkExecute,
): AiSdkToolsConversion {
  const nameMap = buildNameMap(tools);

  const converted = Object.fromEntries(
    tools.map((tool) => {
      const wireName = wireNameFor(nameMap, tool.name);
      const schema = jsonSchema(mutableObjectSchema(tool.inputSchema) as never);
      const descriptor: AiSdkToolDescriptor =
        execute === undefined
          ? {
              description: toolDescription(tool),
              inputSchema: schema,
            }
          : {
              description: toolDescription(tool),
              inputSchema: schema,
              execute: (input) => execute(wireName, input),
            };

      return [wireName, descriptor];
    }),
  );
  return {
    tools: converted,
    nameMap,
    definitions: immutableDefinitions(tools),
  };
}
