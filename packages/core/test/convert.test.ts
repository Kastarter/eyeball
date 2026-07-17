import { describe, expect, it, vi } from "vitest";
import {
  convert,
  JSON_SCHEMA_DRAFT_2020_12,
  type ToolDefinition,
  toAiSdkTools,
  toAnthropicTools,
  toMcpTools,
  toOpenAITools,
} from "../src/index.js";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

const gmailSendEmail = {
  name: "gmail.send_email",
  toolkit: "gmail",
  capability: "email",
  description:
    "Send a new email from the connected email account. Use this for a new " +
    "conversation, not a reply to an existing message or thread. This sends " +
    "content to external recipients; verify recipients, subject, and body first.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:email:send_email:1.0.0:gmail",
    type: "object",
    additionalProperties: false,
    required: ["to", "subject", "body"],
    properties: {
      to: {
        type: "array",
        description: "Primary recipient email addresses.",
        minItems: 1,
        items: { type: "string", format: "email" },
      },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1 },
      bodyFormat: { type: "string", enum: ["text", "html"], default: "text" },
    },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: "urn:eyeball:email:send_email:output:1.0.0:gmail",
    type: "object",
    additionalProperties: false,
    required: ["messageId", "acceptedRecipients"],
    properties: {
      messageId: { type: "string" },
      acceptedRecipients: {
        type: "array",
        items: { type: "string", format: "email" },
      },
    },
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: false,
  },
  version: "1.0.0",
} satisfies ToolDefinition;

const gmailListThreads = {
  name: "gmail.list_threads",
  toolkit: "gmail",
  capability: "email",
  description:
    "List conversation threads and their latest state without changing mailbox state.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    properties: {
      pageSize: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      pageToken: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["threads"],
    properties: {
      threads: { type: "array", items: { type: "object" } },
      nextPageToken: { type: "string" },
    },
  },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    async: false,
  },
  version: "1.0.0",
} satisfies ToolDefinition;

const twilioStartCall = {
  name: "twilio.start_call",
  toolkit: "twilio",
  capability: "voice_telephony",
  description:
    "Start an outbound phone call with a configured voice agent and return its terminal result asynchronously.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["to", "from", "voiceAgentId"],
    properties: {
      to: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" },
      from: { type: "string", pattern: "^\\+[1-9][0-9]{1,14}$" },
      voiceAgentId: { type: "string", minLength: 1 },
    },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["callId", "state", "durationSeconds"],
    properties: {
      callId: { type: "string" },
      state: {
        type: "string",
        enum: ["completed", "busy", "failed", "no_answer"],
      },
      durationSeconds: { type: "integer", minimum: 0 },
    },
  },
  annotations: {
    readOnly: false,
    destructive: false,
    idempotent: false,
    async: true,
  },
  version: "1.0.0",
} satisfies ToolDefinition;

const dynamicsCreateJournalEntry = {
  name: "dynamics-365-business-central.create_journal_entry",
  toolkit: "dynamics-365-business-central",
  capability: "erp_accounting",
  description:
    "Create a general journal entry in Dynamics 365 Business Central after verifying its balancing lines.",
  inputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["journalId", "lines"],
    properties: {
      journalId: { type: "string", minLength: 1 },
      lines: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["accountNumber", "amount"],
          properties: {
            accountNumber: { type: "string", minLength: 1 },
            amount: { type: "number" },
          },
        },
      },
    },
  },
  outputSchema: {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    type: "object",
    additionalProperties: false,
    required: ["entryId"],
    properties: { entryId: { type: "string" } },
  },
  annotations: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    async: false,
  },
  version: "1.0.0",
} satisfies ToolDefinition;

const tools = deepFreeze([
  gmailSendEmail,
  gmailListThreads,
  twilioStartCall,
  dynamicsCreateJournalEntry,
] satisfies readonly ToolDefinition[]);

const restrictedNames = [
  "gmail__send_email",
  "gmail__list_threads",
  "twilio__start_call",
  "dynamics-365-business-central__create_journal_entry",
];

describe("Anthropic tool conversion", () => {
  it("maps names and schemas without mutation", () => {
    const result = toAnthropicTools(tools);

    expect(result.tools.map((tool) => tool.name)).toEqual(restrictedNames);
    expect(result.tools[0]?.input_schema).toEqual(gmailSendEmail.inputSchema);
    expect(result.tools[0]?.input_schema).not.toBe(gmailSendEmail.inputSchema);
    expect(result.nameMap.wireToCanonical.gmail__send_email).toBe(
      "gmail.send_email",
    );
  });

  it("optionally composes trusted annotation hints into descriptions", () => {
    const result = toAnthropicTools(tools, { includeAnnotationHints: true });

    expect(result.tools[1]?.description).toContain(
      "Read-only: does not change external state.",
    );
    expect(result.tools[2]?.description).toContain(
      "Async: this operation must be executed asynchronously.",
    );
    expect(result.tools[3]?.description).toContain("Destructive:");
  });
});

describe("OpenAI tool conversion", () => {
  it("emits chat-completions function descriptors and exact schemas", () => {
    const result = toOpenAITools(tools);

    expect(result.tools.map((tool) => tool.function.name)).toEqual(
      restrictedNames,
    );
    expect(result.tools[0]).toMatchObject({ type: "function" });
    expect(result.tools[0]?.function.parameters).toEqual(
      gmailSendEmail.inputSchema,
    );
    expect(result.tools[0]?.function.parameters).not.toBe(
      gmailSendEmail.inputSchema,
    );
  });

  it("omits strict mode without a version-pinned compatibility validator", () => {
    const result = toOpenAITools(tools);

    for (const tool of result.tools) {
      expect(tool.function).not.toHaveProperty("strict");
    }
  });
});

describe("Vercel AI SDK tool conversion", () => {
  it("returns AI SDK-native descriptors keyed by restricted names", () => {
    const result = toAiSdkTools(tools);

    expect(Object.keys(result.tools)).toEqual(restrictedNames);
    expect(result.tools.gmail__send_email?.inputSchema.jsonSchema).toEqual(
      gmailSendEmail.inputSchema,
    );
    expect(result.tools.gmail__send_email).not.toHaveProperty("execute");
  });

  it("binds each descriptor to the injected wire-name executor", async () => {
    const execute = vi.fn(async (wireName: string, input: unknown) => ({
      wireName,
      input,
    }));
    const result = toAiSdkTools(tools, execute);
    const input = { to: ["buyer@example.com"], subject: "Hi", body: "Hello" };

    await expect(
      result.tools.gmail__send_email?.execute?.(input),
    ).resolves.toEqual({
      wireName: "gmail__send_email",
      input,
    });
    expect(execute).toHaveBeenCalledWith("gmail__send_email", input);
  });
});

describe("MCP tool conversion", () => {
  it("preserves canonical dotted names, schemas, and MCP safety hints", () => {
    const result = toMcpTools(tools);

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "gmail.send_email",
      "gmail.list_threads",
      "dynamics-365-business-central.create_journal_entry",
    ]);
    expect(result.tools[0]?.inputSchema).toEqual(gmailSendEmail.inputSchema);
    expect(result.tools[0]?.inputSchema).not.toBe(gmailSendEmail.inputSchema);
    expect(result.tools[0]?.outputSchema).toEqual(gmailSendEmail.outputSchema);
    expect(result.tools[1]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it("omits async-by-nature tools unless Tasks support is negotiated", () => {
    expect(
      toMcpTools(tools).tools.some((tool) => tool.name === "twilio.start_call"),
    ).toBe(false);
  });

  it("includes async tools with task support after negotiation", () => {
    const result = toMcpTools(tools, { includeAsync: true });
    const asyncTool = result.tools.find(
      (tool) => tool.name === "twilio.start_call",
    );
    const syncTool = result.tools.find(
      (tool) => tool.name === "gmail.send_email",
    );

    expect(asyncTool?.execution).toEqual({ taskSupport: "required" });
    expect(syncTool?.execution).toEqual({ taskSupport: "optional" });
  });
});

describe("shared conversion guarantees", () => {
  it("round-trips every emitted name through the canonical name map", () => {
    const anthropic = toAnthropicTools(tools);
    const openai = toOpenAITools(tools);
    const aiSdk = toAiSdkTools(tools);
    const mcp = toMcpTools(tools, { includeAsync: true });
    for (const tool of anthropic.tools) {
      expect(anthropic.nameMap.wireToCanonical[tool.name]).toBeDefined();
    }
    for (const tool of openai.tools) {
      expect(openai.nameMap.wireToCanonical[tool.function.name]).toBeDefined();
    }
    for (const wireName of Object.keys(aiSdk.tools)) {
      expect(aiSdk.nameMap.wireToCanonical[wireName]).toBeDefined();
    }
    for (const tool of mcp.tools) {
      expect(mcp.nameMap.wireToCanonical[tool.name]).toBe(tool.name);
    }
  });

  it.each([
    ["Anthropic", () => toAnthropicTools([gmailSendEmail, gmailSendEmail])],
    ["OpenAI", () => toOpenAITools([gmailSendEmail, gmailSendEmail])],
    ["AI SDK", () => toAiSdkTools([gmailSendEmail, gmailSendEmail])],
    ["MCP", () => toMcpTools([gmailSendEmail, gmailSendEmail])],
  ])("propagates collision detection for %s", (_format, converter) => {
    expect(converter).toThrow("Canonical tool name collision");
  });

  it("never emits an empty description", () => {
    const descriptions = [
      ...toAnthropicTools(tools).tools.map((tool) => tool.description),
      ...toOpenAITools(tools).tools.map((tool) => tool.function.description),
      ...Object.values(toAiSdkTools(tools).tools).map(
        (tool) => tool.description,
      ),
      ...toMcpTools(tools).tools.map((tool) => tool.description),
    ];

    expect(descriptions.every((description) => description.length > 0)).toBe(
      true,
    );
  });

  it.each([
    ["Anthropic", toAnthropicTools],
    ["OpenAI", toOpenAITools],
    ["AI SDK", toAiSdkTools],
    ["MCP", toMcpTools],
  ] as const)("rejects empty canonical descriptions for %s", (_format, converter) => {
    const invalidTool = {
      ...gmailSendEmail,
      name: "gmail.empty_description",
      description: "   ",
    } satisfies ToolDefinition;

    expect(() => converter([invalidTool])).toThrow(
      "Tool description must not be empty",
    );
  });

  it("dispatches to each typed format converter", () => {
    expect(convert(tools, "anthropic")).toHaveProperty("nameMap");
    expect(convert(tools, "openai")).toHaveProperty("nameMap");
    expect(convert(tools, "ai-sdk").tools).toHaveProperty("gmail__send_email");
    expect(convert(tools, "mcp").tools[0]?.name).toBe("gmail.send_email");
  });

  it("returns detached, deeply immutable definition sidecars", () => {
    const source = structuredClone([gmailSendEmail]);
    const bundle = toAnthropicTools(source);

    expect(bundle.definitions).toEqual(source);
    expect(bundle.definitions).not.toBe(source);
    expect(Object.isFrozen(bundle.definitions)).toBe(true);
    expect(Object.isFrozen(bundle.definitions[0]?.inputSchema)).toBe(true);

    const sourceTool = source[0];
    if (sourceTool === undefined) {
      throw new Error("Expected the source fixture to contain one tool.");
    }
    sourceTool.description = "Changed after conversion.";
    expect(bundle.definitions[0]?.description).toBe(gmailSendEmail.description);
  });
});
