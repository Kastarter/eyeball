import { buildNameMap, type ExecutionId, isExecutionId } from "@eyeball/core";
import { createMcpDemoEnvironment, type InProcessMcpClient } from "./mcp.js";

export const DEFAULT_ANTHROPIC_DEMO_MODEL = "claude-sonnet-4-6";

const DEMO_TOOL_NAMES = [
  "gmail.send_email",
  "github.create_issue",
  "slack.send_message",
] as const;

const DEFAULT_PROMPT = `Run this fixture workflow in order:
1. Email owner@acme.example with subject "Agent-loop kickoff" and body "The Anthropic Eyeball agent started the workflow."
2. Create a GitHub issue in acme-example/eyeball-fixture titled "Follow up on the Anthropic demo", body "Created by the optional Anthropic MCP episode.", with label enhancement.
3. After the issue result gives you its issueId, send "Created GitHub issue #<issueId> after sending the kickoff email." to Slack conversation C_GENERAL.
Call each tool exactly once, use only the supplied fixture values, and finish with a one-sentence summary.`;

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
}

type AnthropicMessageParam =
  | { role: "user"; content: string | readonly AnthropicToolResultBlock[] }
  | { role: "assistant"; content: readonly AnthropicContentBlock[] };

export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  temperature: number;
  system: string;
  tools: readonly {
    name: string;
    description: string;
    input_schema: Readonly<Record<string, unknown>>;
  }[];
  messages: readonly AnthropicMessageParam[];
}

export interface AnthropicMessageResponse {
  id: string;
  content: readonly AnthropicContentBlock[];
  stop_reason: string | null;
}

export interface AnthropicMessagesClient {
  create(request: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
}

export interface AnthropicHttpClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  url?: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessageResponse(value: unknown): AnthropicMessageResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !Array.isArray(value.content) ||
    (value.stop_reason !== null && typeof value.stop_reason !== "string")
  ) {
    throw new Error("Anthropic returned an invalid Messages response.");
  }
  const content = value.content.map((block) => {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new Error("Anthropic returned an invalid content block.");
    }
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text" as const, text: block.text };
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      return {
        type: "tool_use" as const,
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    throw new Error("Anthropic returned an unsupported content block.");
  });
  return {
    id: value.id,
    content,
    stop_reason: value.stop_reason,
  };
}

/** Minimal Messages REST client so the optional demo adds no production dependency. */
export function createAnthropicMessagesClient(
  options: AnthropicHttpClientOptions,
): AnthropicMessagesClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = options.url ?? "https://api.anthropic.com/v1/messages";
  if (options.apiKey.trim().length === 0) {
    throw new Error("ANTHROPIC_API_KEY must not be empty.");
  }
  return {
    async create(request) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": options.apiKey,
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        throw new Error(
          `Anthropic Messages request failed with HTTP ${response.status}.`,
        );
      }
      return parseMessageResponse((await response.json()) as unknown);
    },
  };
}

export interface RunAnthropicMcpLoopOptions {
  client: InProcessMcpClient;
  anthropic: AnthropicMessagesClient;
  model?: string;
  prompt?: string;
  maxSteps?: number;
}

export interface AnthropicMcpLoopResult {
  finalText: string;
  steps: number;
  calls: readonly {
    toolUseId: string;
    wireName: string;
    canonicalName: string;
    executionId?: ExecutionId;
    isError: boolean;
  }[];
}

function positiveStepCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("maxSteps must be an integer from 1 through 20.");
  }
  return value;
}

/** Bounded Anthropic tool-use loop whose model calls are dispatched through MCP. */
export async function runAnthropicMcpLoop(
  options: RunAnthropicMcpLoopOptions,
): Promise<AnthropicMcpLoopResult> {
  const maxSteps = positiveStepCount(options.maxSteps ?? 8);
  const listed = await options.client.listTools();
  const nameMap = buildNameMap(DEMO_TOOL_NAMES.map((name) => ({ name })));
  const tools = DEMO_TOOL_NAMES.map((canonicalName) => {
    const descriptor = listed.find(({ name }) => name === canonicalName);
    if (descriptor === undefined) {
      throw new Error(`MCP tools/list omitted ${canonicalName}.`);
    }
    const wireName = nameMap.canonicalToWire[canonicalName];
    if (wireName === undefined) {
      throw new Error(`Anthropic name map omitted ${canonicalName}.`);
    }
    return {
      name: wireName,
      description: descriptor.description,
      input_schema: descriptor.inputSchema,
    };
  });

  const messages: AnthropicMessageParam[] = [
    { role: "user", content: options.prompt ?? DEFAULT_PROMPT },
  ];
  const calls: AnthropicMcpLoopResult["calls"][number][] = [];
  for (let step = 1; step <= maxSteps; step += 1) {
    const reply = await options.anthropic.create({
      model: options.model ?? DEFAULT_ANTHROPIC_DEMO_MODEL,
      max_tokens: 1_024,
      temperature: 0,
      system:
        "You are a bounded fixture agent. Follow the workflow exactly, call only declared tools, preserve tool-result IDs, and never invent provider data.",
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: reply.content });
    const toolUses = reply.content.filter(
      (block): block is AnthropicToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      if (reply.stop_reason !== "end_turn") {
        throw new Error(
          `Anthropic stopped with ${reply.stop_reason ?? "no reason"} before completing the workflow.`,
        );
      }
      const finalText = reply.content
        .filter((block): block is AnthropicTextBlock => block.type === "text")
        .map(({ text }) => text)
        .join("\n")
        .trim();
      if (finalText.length === 0) {
        throw new Error(
          `Anthropic stopped with ${reply.stop_reason ?? "no reason"} and no final text.`,
        );
      }
      return { finalText, steps: step, calls };
    }
    if (reply.stop_reason !== "tool_use") {
      throw new Error(
        `Anthropic returned tool calls with unexpected stop reason ${reply.stop_reason ?? "none"}.`,
      );
    }

    const results: AnthropicToolResultBlock[] = [];
    for (const use of toolUses) {
      const canonicalName = nameMap.wireToCanonical[use.name];
      if (canonicalName === undefined || !isRecord(use.input)) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify({
            code: "invalid_input",
            message: "The model requested an unknown tool or invalid input.",
            retryable: false,
          }),
          is_error: true,
        });
        calls.push({
          toolUseId: use.id,
          wireName: use.name,
          canonicalName: canonicalName ?? "unknown",
          isError: true,
        });
        continue;
      }

      const result = await options.client.callRaw(canonicalName, use.input);
      const executionId = result._meta?.["dev.eyeball/execution"]?.executionId;
      if (executionId === undefined || !isExecutionId(executionId)) {
        throw new Error(
          `MCP tool ${canonicalName} omitted a valid execution ID.`,
        );
      }
      const content =
        result.structuredContent === undefined
          ? (result.content?.[0]?.text ?? "null")
          : JSON.stringify(result.structuredContent);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content,
        ...(result.isError === true ? { is_error: true } : {}),
      });
      calls.push({
        toolUseId: use.id,
        wireName: use.name,
        canonicalName,
        executionId,
        isError: result.isError === true,
      });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error(`Anthropic did not finish within ${maxSteps} model steps.`);
}

export interface RunLiveAnthropicMcpDemoOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

/** Optional live-model layer; providers and Eyeball services remain deterministic mocks. */
export async function runLiveAnthropicMcpDemo(
  options: RunLiveAnthropicMcpDemoOptions,
): Promise<AnthropicMcpLoopResult> {
  const environment = await createMcpDemoEnvironment("catalog");
  return runAnthropicMcpLoop({
    client: environment.client,
    anthropic: createAnthropicMessagesClient({
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
}
