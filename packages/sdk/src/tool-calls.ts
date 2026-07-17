import { EyeballError, type JsonValue, TOOL_ERROR_CODES } from "@eyeball/core";
import type { Eyeball } from "./client.js";
import type {
  AnthropicToolCall,
  AnthropicToolResultBlock,
  ExecuteToolCallsOptions,
  OpenAIToolCall,
  OpenAIToolResultMessage,
  RunToolOptions,
} from "./types.js";

function anthropicCall(
  call: AnthropicToolCall | OpenAIToolCall,
): call is AnthropicToolCall {
  return "type" in call && call.type === "tool_use";
}

function openAIInput(
  value: string | Readonly<Record<string, JsonValue>>,
): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (cause) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: "OpenAI tool-call arguments must contain valid JSON.",
      retryable: false,
      cause,
    });
  }
}

function serialized(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function serializedError(error: unknown): string {
  if (error instanceof EyeballError) {
    return serialized({ error: error.toJSON() });
  }
  return serialized({
    error: {
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "Tool execution failed unexpectedly.",
      retryable: false,
    },
  });
}

function runOptions(options: ExecuteToolCallsOptions): RunToolOptions {
  return {
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.connectionId === undefined
      ? {}
      : { connectionId: options.connectionId }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

function toolCallOptions(
  options: RunToolOptions,
  format: "anthropic" | "openai",
  callId: string,
): RunToolOptions {
  return {
    ...options,
    // Framework call IDs identify one logical model-requested action and remain
    // stable when an application retries dispatching the same response.
    idempotencyKey: `${format}:${callId}`,
  };
}

/**
 * Dispatches framework tool calls and returns model-ready result blocks. Each call's
 * framework ID becomes its stable, format-prefixed idempotency key so redispatching the
 * same model response reuses the original execution instead of duplicating a mutation.
 */
export function executeToolCalls(
  eyeball: Eyeball,
  calls: readonly AnthropicToolCall[],
  options?: ExecuteToolCallsOptions,
): Promise<AnthropicToolResultBlock[]>;
export function executeToolCalls(
  eyeball: Eyeball,
  calls: readonly OpenAIToolCall[],
  options?: ExecuteToolCallsOptions,
): Promise<OpenAIToolResultMessage[]>;
export function executeToolCalls(
  eyeball: Eyeball,
  calls: readonly (AnthropicToolCall | OpenAIToolCall)[],
  options: ExecuteToolCallsOptions = {},
): Promise<(AnthropicToolResultBlock | OpenAIToolResultMessage)[]> {
  const invocationOptions = runOptions(options);
  return Promise.all(
    calls.map(async (call) => {
      if (anthropicCall(call)) {
        try {
          const output = await eyeball.tools.run(
            call.name,
            call.input,
            toolCallOptions(invocationOptions, "anthropic", call.id),
          );
          return {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: serialized(output),
          };
        } catch (error) {
          return {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: serializedError(error),
            is_error: true,
          };
        }
      }

      try {
        const output = await eyeball.tools.run(
          call.function.name,
          openAIInput(call.function.arguments),
          toolCallOptions(invocationOptions, "openai", call.id),
        );
        return {
          role: "tool" as const,
          tool_call_id: call.id,
          content: serialized(output),
        };
      } catch (error) {
        return {
          role: "tool" as const,
          tool_call_id: call.id,
          content: serializedError(error),
        };
      }
    }),
  );
}
