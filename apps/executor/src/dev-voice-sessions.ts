import type { JsonValue, VoiceAgentSessionState } from "@eyeball/core";
import {
  type AgentStore,
  runVoiceSessionDriverTick,
  type VoiceSessionDriverClock,
  type VoiceSessionDriverTickResult,
  type VoiceSessionTurnHandler,
} from "@eyeball/toolkits";
import type { ExecutionEngine } from "./engine.js";

const CALENDAR_INPUT = {
  calendarId: "primary",
  title: "Table for four — Sam",
  description: "Restaurant reservation created by the Table Host voice agent.",
  startTime: "2026-01-02T16:00:00.000Z",
  endTime: "2026-01-02T17:30:00.000Z",
  timeZone: "Asia/Riyadh",
  attendees: [{ email: "sam@example.com", displayName: "Sam" }],
} as const satisfies Readonly<Record<string, JsonValue>>;

const EMAIL_INPUT = {
  to: ["sam@example.com"],
  subject: "Your table is confirmed",
  body: "Your table for four is confirmed for tomorrow at 7:00 PM.",
} as const satisfies Readonly<Record<string, JsonValue>>;

export interface DevVoiceSessionAdvanceInput {
  projectId: string;
  userId: string;
  sessionId: string;
  milliseconds: number;
  end?: boolean;
}

export interface DevVoiceSessionAdvanceResult
  extends VoiceSessionDriverTickResult {
  advancedByMs: number;
}

export interface DevVoiceSessionAdvancer {
  advance(
    input: DevVoiceSessionAdvanceInput,
  ): Promise<DevVoiceSessionAdvanceResult>;
}

export interface DevVoiceSessionRuntimeOptions {
  engine: ExecutionEngine;
  agentStore: AgentStore;
  pipecatBaseUrl: string;
  clock: VoiceSessionDriverClock;
  fetch?: typeof globalThis.fetch;
  turnHandler?: VoiceSessionTurnHandler;
}

function endpoint(baseUrl: string, sessionId: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    `sessions/${encodeURIComponent(sessionId)}/end`,
    base,
  ).toString();
}

/** Deterministic reservation fixture used only by the development test panel. */
export const restaurantDemoTurnHandler: VoiceSessionTurnHandler = {
  async respond({ humanTurn }) {
    const normalized = humanTurn.text.toLocaleLowerCase("en");
    if (normalized.includes("confirmation")) {
      return {
        text: "The table is reserved. I’ll email the confirmation now.",
        toolCall: { tool: "gmail.send_email", input: EMAIL_INPUT },
      };
    }
    if (
      normalized.includes("table") ||
      normalized.includes("reservation") ||
      normalized.includes("tomorrow at 7")
    ) {
      return {
        text: "I’ll reserve the table and then send your confirmation.",
        toolCall: {
          tool: "google-calendar.create_event",
          input: CALENDAR_INPUT,
        },
      };
    }
    return {
      text: `I heard: ${humanTurn.text}. This scripted test agent is ready.`,
    };
  },
};

/**
 * Request-driven worker harness for the dashboard demo. The runtime is only
 * reachable when createExecutorApp also receives a dev vault.
 */
export class DevVoiceSessionRuntime implements DevVoiceSessionAdvancer {
  readonly #engine: ExecutionEngine;
  readonly #agentStore: AgentStore;
  readonly #pipecatBaseUrl: string;
  readonly #clock: VoiceSessionDriverClock;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #turnHandler: VoiceSessionTurnHandler;
  readonly #cursors = new Map<string, number>();

  constructor(options: DevVoiceSessionRuntimeOptions) {
    this.#engine = options.engine;
    this.#agentStore = options.agentStore;
    this.#pipecatBaseUrl = options.pipecatBaseUrl;
    this.#clock = options.clock;
    this.#fetchImpl = options.fetch ?? globalThis.fetch;
    this.#turnHandler = options.turnHandler ?? restaurantDemoTurnHandler;
  }

  async advance(
    input: DevVoiceSessionAdvanceInput,
  ): Promise<DevVoiceSessionAdvanceResult> {
    const pointer = this.#agentStore.getSession(
      input.projectId,
      input.userId,
      input.sessionId,
    );
    const agent = this.#agentStore.getAgent(
      input.projectId,
      pointer.agentId,
      pointer.agentRevision,
    );
    const cursorKey = `${input.projectId}\u0000${input.userId}\u0000${input.sessionId}`;

    if (input.end === true) {
      const response = await this.#fetchImpl(
        endpoint(this.#pipecatBaseUrl, input.sessionId),
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          `Pipecat end-session request failed with HTTP ${response.status}.`,
        );
      }
    }

    await this.#clock.advance(input.milliseconds);
    const result = await runVoiceSessionDriverTick({
      sessionRef: {
        sessionId: input.sessionId,
        afterSequence: this.#cursors.get(cursorKey) ?? 0,
      },
      agentRevision: {
        id: agent.id,
        revision: agent.revision,
        projectId: input.projectId,
        userId: input.userId,
        tools: agent.tools,
      },
      executionEngine: this.#engine,
      pipecatBaseUrl: this.#pipecatBaseUrl,
      fetch: this.#fetchImpl,
      turnHandler: this.#turnHandler,
    });
    this.#cursors.set(cursorKey, result.lastSequence);
    for (const event of result.events) {
      if (!agent.webhooks.events.includes(event.data.type)) continue;
      await this.#engine.webhookDeliverer.enqueueVoiceSessionEvent({
        projectId: input.projectId,
        endpointIds: agent.webhooks.endpointIds,
        event,
      });
    }
    return { ...result, advancedByMs: input.milliseconds };
  }
}

export function isTerminalVoiceSessionState(
  state: VoiceAgentSessionState,
): boolean {
  return state === "completed" || state === "failed" || state === "abandoned";
}
