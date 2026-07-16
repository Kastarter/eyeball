import {
  type CapabilityToolContract,
  JSON_SCHEMA_DRAFT_2020_12,
  type JSONSchema202012,
  type ObjectSchema202012,
  type ToolAnnotations,
  voiceAgentSchemaDefs,
} from "@eyeball/core";
import { deepFreeze } from "../immutable.js";
import { defineContract } from "./schema.js";

const CAPABILITY = "voice_telephony" as const;
const VERSION = "1.0.0" as const;

type SchemaProperties = Readonly<Record<string, JSONSchema202012>>;

interface VoiceAgentToolRow {
  operation: string;
  description: string;
  input: SchemaProperties;
  inputRequired?: readonly string[];
  output: SchemaProperties;
  outputRequired?: readonly string[];
  annotations: ToolAnnotations;
}

const ref = (name: string): JSONSchema202012 => ({
  $ref: `#/$defs/${name}`,
});
const id: JSONSchema202012 = { type: "string", minLength: 1 };
const revision: JSONSchema202012 = { type: "integer", minimum: 1 };
const cursor: JSONSchema202012 = { type: "string", minLength: 1 };
const timestamp: JSONSchema202012 = { type: "string", format: "date-time" };
const e164: JSONSchema202012 = {
  type: "string",
  pattern: "^\\+[1-9][0-9]{7,14}$",
};
const state: JSONSchema202012 = {
  type: "string",
  enum: [
    "created",
    "connecting",
    "in-progress",
    "wrap-up",
    "completed",
    "failed",
    "abandoned",
  ],
};
const read: ToolAnnotations = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
};
const write: ToolAnnotations = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: false,
};
const asyncWrite: ToolAnnotations = {
  readOnly: false,
  destructive: false,
  idempotent: false,
  async: true,
};

function scriptProperty(): JSONSchema202012 {
  return {
    type: "array",
    description:
      "Optional deterministic caller script passed to the mock Pipecat runtime. It is runtime input and never becomes part of the agent definition.",
    items: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["caller"],
          properties: {
            caller: { type: "string", minLength: 1 },
            delayMs: { type: "integer", minimum: 0 },
            durationMs: { type: "integer", minimum: 0 },
            dtmf: { type: "string", pattern: "^[0-9A-D*#wW]+$" },
            hangup: { type: "boolean" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["expect_tool_call"],
          properties: {
            expect_tool_call: { type: "string", minLength: 3 },
            input: { type: "object", additionalProperties: true },
            result: true,
            error: { type: "object", additionalProperties: true },
          },
          not: {
            required: ["result", "error"],
            properties: { result: true, error: true },
          },
        },
      ],
    },
  };
}

const rows: readonly VoiceAgentToolRow[] = [
  {
    operation: "create_voice_agent",
    description:
      "Create revision 1 of a portable voice-agent definition. The definition contains references and policy only, never provider credentials.",
    input: { agent: ref("agentDraft") },
    inputRequired: ["agent"],
    output: { agent: ref("agentDefinition") },
    outputRequired: ["agent"],
    annotations: write,
  },
  {
    operation: "get_voice_agent",
    description:
      "Retrieve one immutable voice-agent revision. When revision is omitted, resolve the active revision.",
    input: { agentId: id, revision },
    inputRequired: ["agentId"],
    output: { agent: ref("agentDefinition") },
    outputRequired: ["agent"],
    annotations: read,
  },
  {
    operation: "list_voice_agents",
    description:
      "List stable voice-agent resources as summaries; full prompts and definitions are intentionally omitted.",
    input: {
      transport: ref("transport"),
      includeDeleted: { type: "boolean", default: false },
      cursor,
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
    output: {
      agents: { type: "array", items: ref("agentSummary") },
      nextCursor: cursor,
    },
    outputRequired: ["agents"],
    annotations: read,
  },
  {
    operation: "update_voice_agent",
    description:
      "Append an immutable revision using optimistic expected-revision concurrency. Existing revisions and pinned sessions are unchanged.",
    input: {
      agentId: id,
      expectedRevision: revision,
      agent: ref("agentDraft"),
    },
    inputRequired: ["agentId", "expectedRevision", "agent"],
    output: { agent: ref("agentDefinition") },
    outputRequired: ["agent"],
    annotations: write,
  },
  {
    operation: "delete_voice_agent",
    description:
      "Tombstone a stable voice-agent resource while retaining immutable revisions needed by sessions and transcript policy.",
    input: { agentId: id, expectedRevision: revision },
    inputRequired: ["agentId", "expectedRevision"],
    output: { agentId: id, deletedAt: timestamp },
    outputRequired: ["agentId", "deletedAt"],
    annotations: {
      readOnly: false,
      destructive: true,
      idempotent: true,
      async: false,
    },
  },
  {
    operation: "start_agent_call",
    description:
      "Start an outbound phone session pinned to one voice-agent revision. This is asynchronous by nature.",
    input: {
      agentId: id,
      revision,
      to: e164,
      from: e164,
      transportConnectionId: id,
      metadata: { type: "object", additionalProperties: true },
      script: scriptProperty(),
    },
    inputRequired: ["agentId", "to"],
    output: {
      session: ref("session"),
      callId: id,
      transcriptArtifactId: id,
    },
    outputRequired: ["session", "callId"],
    annotations: asyncWrite,
  },
  {
    operation: "attach_agent_to_number",
    description:
      "Bind an inbound Twilio number to a resolved immutable agent revision and transport connection.",
    input: {
      agentId: id,
      revision,
      phoneNumber: e164,
      transportConnectionId: id,
    },
    inputRequired: ["agentId", "phoneNumber", "transportConnectionId"],
    output: { bindingId: id, agentId: id, revision, phoneNumber: e164 },
    outputRequired: ["bindingId", "agentId", "revision", "phoneNumber"],
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: true,
      async: false,
    },
  },
  {
    operation: "get_agent_session",
    description:
      "Retrieve one pinned agent session and an incremental page of gap-free ordered events.",
    input: {
      sessionId: id,
      afterSequence: { type: "integer", minimum: 0, default: 0 },
      eventLimit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: 50,
      },
    },
    inputRequired: ["sessionId"],
    output: {
      session: ref("session"),
      events: { type: "array", items: ref("event") },
      nextSequence: { type: "integer", minimum: 0 },
    },
    outputRequired: ["session", "events", "nextSequence"],
    annotations: read,
  },
  {
    operation: "list_agent_sessions",
    description:
      "List agent sessions visible in the current trusted project and user scope.",
    input: {
      agentId: id,
      state,
      cursor,
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
    },
    output: {
      sessions: { type: "array", items: ref("session") },
      nextCursor: cursor,
    },
    outputRequired: ["sessions"],
    annotations: read,
  },
  {
    operation: "get_session_transcript",
    description:
      "Build the normalized transcript artifact for a session, including surfaced tool-call turns.",
    input: {
      sessionId: id,
      includePartial: { type: "boolean", default: false },
    },
    inputRequired: ["sessionId"],
    output: { artifact: ref("transcriptArtifact") },
    outputRequired: ["artifact"],
    annotations: read,
  },
  {
    operation: "send_session_message",
    description:
      "Run one text-chat turn against a new or existing pinned session. This is asynchronous by nature and deduplicates by clientMessageId.",
    input: {
      agentId: id,
      revision,
      sessionId: id,
      message: { type: "string", minLength: 1 },
      clientMessageId: id,
    },
    inputRequired: ["agentId", "message", "clientMessageId"],
    output: {
      session: ref("session"),
      userMessageId: id,
      assistantMessage: { type: "string" },
    },
    outputRequired: ["session", "userMessageId", "assistantMessage"],
    annotations: asyncWrite,
  },
];

function schema(
  operation: string,
  side: "input" | "output",
  properties: SchemaProperties,
  required: readonly string[] = [],
): ObjectSchema202012 {
  const suffix = side === "input" ? "" : ":output";
  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    $id: `urn:eyeball:voice-agents:${operation}${suffix}:${VERSION}`,
    $defs: voiceAgentSchemaDefs,
    type: "object",
    additionalProperties: false,
    ...(required.length === 0 ? {} : { required }),
    properties,
  };
}

export const voiceAgentCapabilityContracts = deepFreeze(
  rows.map((row) =>
    defineContract({
      capability: CAPABILITY,
      name: row.operation,
      description: row.description,
      inputSchema: schema(row.operation, "input", row.input, row.inputRequired),
      outputSchema: schema(
        row.operation,
        "output",
        row.output,
        row.outputRequired,
      ),
      annotations: row.annotations,
      version: VERSION,
    }),
  ) as readonly CapabilityToolContract[],
);

export const voiceAgentContractsByName = deepFreeze(
  Object.fromEntries(
    voiceAgentCapabilityContracts.map((contract) => [contract.name, contract]),
  ) as Readonly<Record<string, CapabilityToolContract>>,
);
