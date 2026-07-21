"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import {
  Button,
  CodeBlock,
  CopyButton,
  Icon,
  Input,
  Select,
  TableShell,
} from "@/src/components/ui";
import {
  dashboardExecutorClient,
  type ExecuteToolResponse,
  ExecutorApiError,
  type JsonValue,
} from "@/src/lib/api";
import {
  hydrateVoiceSessionLink,
  parseVoiceSessionLink,
  type VoiceSessionLink,
} from "@/src/lib/voice-session-link";
import {
  projectTranscriptEvents,
  type TranscriptToolItem,
  type VoiceSessionEvent,
} from "@/src/lib/voice-transcript";

// Must match the dev-stack's seeded connection identity (EYEBALL_DEV_USER_ID
// default); a user without seeded connections fails credential resolution.
const DASHBOARD_USER_ID =
  process.env.NEXT_PUBLIC_EYEBALL_DEMO_USER ?? "demo_user";
const SESSION_POLL_MS = 1_700;

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

const RESERVATION_SCRIPT = [
  {
    caller: "Tomorrow at 7, a table for four under Sam. Email sam@example.com.",
  },
  {
    expect_tool_call: "google-calendar.create_event",
    input: CALENDAR_INPUT,
  },
  { caller: "Please send the confirmation to sam@example.com." },
  { expect_tool_call: "gmail.send_email", input: EMAIL_INPUT },
] as const;

const FIXTURE_VOICES = [
  { label: "Warm host", value: "voice_fixture_warm_host" },
  { label: "Calm concierge", value: "voice_fixture_calm_concierge" },
  { label: "Bright guide", value: "voice_fixture_bright_guide" },
] as const;

export type VoiceAgentTransport = "pstn:twilio" | "webrtc:livekit" | "chat";
export type VoiceSessionState =
  | "created"
  | "connecting"
  | "in-progress"
  | "wrap-up"
  | "completed"
  | "failed"
  | "abandoned";

export interface CatalogToolOption {
  capability: string;
  name: string;
  toolkit: string;
}

export interface VoiceAgentSummary {
  id: string;
  activeRevision: number;
  name: string;
  transport: VoiceAgentTransport;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceAgentDefinition {
  id: string;
  revision: number;
  name: string;
  systemPrompt: string;
  llm: { model: string; temperature?: number; maxOutputTokens?: number };
  voice: {
    tts: { provider: "elevenlabs"; voiceId: string; stability?: number };
    stt: {
      provider: "deepgram";
      model?: string;
      language?: string;
      smartFormat?: boolean;
    };
  };
  transport: VoiceAgentTransport;
  tools: readonly string[];
  guardrails: {
    maxDurationSeconds: number;
    handoffToHuman: { enabled: false };
  };
  webhooks: {
    endpointIds: readonly string[];
    transcript: boolean;
    events: readonly string[];
  };
  recordingPolicy: {
    mode: "audio_and_transcript";
    consent: "agent_announcement";
    retentionDays: number;
    redactDtmf: boolean;
  };
  createdAt: string;
}

interface VoiceSession {
  id: string;
  projectId: string;
  agentId: string;
  agentRevision: number;
  transport: VoiceAgentTransport;
  state: VoiceSessionState;
  userId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  lastEventSequence: number;
}

interface TranscriptArtifact {
  id: string;
  final: boolean;
  turns: readonly unknown[];
}

interface BuilderState {
  name: string;
  systemPrompt: string;
  llmModel: string;
  voiceId: string;
  sttModel: string;
  transport: VoiceAgentTransport;
  tools: readonly string[];
  maxDurationSeconds: string;
}

export interface VoiceAgentsScreenProps {
  initialAgents?: readonly VoiceAgentSummary[];
  initialDefinitions?: Readonly<Record<string, VoiceAgentDefinition>>;
  initialRevision?: number;
  initialSelectedAgent?: string;
  initialSessionId?: string;
  initialSessionUserId?: string;
  project: string;
  tools: readonly CatalogToolOption[];
}

type PanelState = "error" | "loading" | "offline" | "ready" | "unconfigured";

function requestState(
  error: unknown,
): Exclude<PanelState, "loading" | "ready"> {
  if (error instanceof ExecutorApiError && error.status === 401)
    return "unconfigured";
  if (!(error instanceof ExecutorApiError) || error.status === 502)
    return "offline";
  return "error";
}

function asRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function outputRecord(
  execution: ExecuteToolResponse,
): Readonly<Record<string, unknown>> {
  if (execution.status === "failed") {
    throw new Error(`${execution.error.code}: ${execution.error.message}`);
  }
  if (execution.status !== "succeeded") {
    throw new Error("Execution did not reach a terminal state.");
  }
  return asRecord(execution.output, "Execution output");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function terminalExecution(
  execution: ExecuteToolResponse,
  project?: string,
): Promise<ExecuteToolResponse> {
  if (execution.status === "succeeded" || execution.status === "failed")
    return execution;
  const client = dashboardExecutorClient(project);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(200);
    const detail = await client.getExecution(execution.executionId);
    if (detail.status === "succeeded" || detail.status === "failed")
      return detail;
  }
  throw new Error(`Execution ${execution.executionId} did not finish in time.`);
}

async function runVoiceTool(
  tool: string,
  input: Readonly<Record<string, JsonValue>>,
  mode: "async" | "sync" = "sync",
  mutate = false,
  identity: { readonly project?: string; readonly userId?: string } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const execution = await dashboardExecutorClient(identity.project).execute(
    { tool, userId: identity.userId ?? DASHBOARD_USER_ID, input, mode },
    mutate
      ? { idempotencyKey: `dashboard:${tool}:${crypto.randomUUID()}` }
      : {},
  );
  return outputRecord(await terminalExecution(execution, identity.project));
}

async function resolveTransportConnectionId(toolkit: string): Promise<string> {
  const page = await dashboardExecutorClient().listConnections();
  const match = page.connections.find(
    (connection) =>
      connection.toolkit === toolkit &&
      connection.userId === DASHBOARD_USER_ID &&
      connection.status === "connected",
  );
  if (match === undefined) {
    throw new Error(
      `No connected ${toolkit} connection exists for ${DASHBOARD_USER_ID}; create one on the Connections screen first.`,
    );
  }
  return match.connectionId;
}

function defaultBuilder(tools: readonly CatalogToolOption[]): BuilderState {
  const available = new Set(tools.map(({ name }) => name));
  const preferred = ["google-calendar.create_event", "gmail.send_email"].filter(
    (name) => available.has(name),
  );
  return {
    name: "Table Host",
    systemPrompt:
      "Book restaurant tables only after confirming date, time, party size, name, and email. Create the calendar event, email a concise confirmation, and never invent availability.",
    llmModel: "model:fixture:restaurant-concierge",
    voiceId: "voice_fixture_warm_host",
    sttModel: "nova-3",
    transport: "pstn:twilio",
    tools:
      preferred.length > 0
        ? preferred
        : tools.slice(0, 2).map(({ name }) => name),
    maxDurationSeconds: "600",
  };
}

function builderFromAgent(agent: VoiceAgentDefinition): BuilderState {
  return {
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    llmModel: agent.llm.model,
    voiceId: agent.voice.tts.voiceId,
    sttModel: agent.voice.stt.model ?? "nova-3",
    transport: agent.transport,
    tools: agent.tools,
    maxDurationSeconds: String(agent.guardrails.maxDurationSeconds),
  };
}

function draftFromBuilder(
  builder: BuilderState,
): Readonly<Record<string, JsonValue>> {
  return {
    name: builder.name.trim(),
    systemPrompt: builder.systemPrompt.trim(),
    llm: {
      model: builder.llmModel.trim(),
      temperature: 0.2,
      maxOutputTokens: 600,
    },
    voice: {
      tts: {
        provider: "elevenlabs",
        voiceId: builder.voiceId,
        stability: 0.55,
      },
      stt: {
        provider: "deepgram",
        model: builder.sttModel.trim(),
        language: "en",
        smartFormat: true,
      },
    },
    transport: builder.transport,
    tools: builder.tools,
    guardrails: {
      maxDurationSeconds: Number(builder.maxDurationSeconds),
      handoffToHuman: { enabled: false },
    },
    webhooks: {
      endpointIds: [],
      transcript: true,
      events: [
        "session.lifecycle",
        "turn.transcript",
        "tool_call",
        "tool_result",
      ],
    },
    recordingPolicy: {
      mode: "audio_and_transcript",
      consent: "agent_announcement",
      retentionDays: 30,
      redactDtmf: true,
    },
  };
}

function parseAgent(value: unknown): VoiceAgentDefinition {
  return value as VoiceAgentDefinition;
}

function parseSession(value: unknown): VoiceSession {
  return value as VoiceSession;
}

function transportLabel(transport: VoiceAgentTransport): string {
  if (transport === "pstn:twilio") return "PSTN · Twilio";
  if (transport === "webrtc:livekit") return "WebRTC · LiveKit";
  return "Chat";
}

function terminalSession(state: VoiceSessionState): boolean {
  return state === "completed" || state === "failed" || state === "abandoned";
}

function voiceUrl(agentId?: string, revision?: number, create = false): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("agent");
  url.searchParams.delete("revision");
  url.searchParams.delete("new");
  url.searchParams.delete("session");
  url.searchParams.delete("userId");
  if (create) url.searchParams.set("new", "true");
  if (agentId !== undefined) url.searchParams.set("agent", agentId);
  if (revision !== undefined)
    url.searchParams.set("revision", String(revision));
  return `${url.pathname}${url.search}${url.hash}`;
}

function ToolEvent({
  item,
  project,
}: {
  item: TranscriptToolItem;
  project: string;
}) {
  const complete = item.output !== undefined || item.error !== undefined;
  return (
    <details className="voice-tool-event">
      <summary>
        <span className="voice-tool-event__kind">
          {complete ? "tool_result" : "tool_call"}
        </span>
        <code>{item.tool}</code>
        <span>
          {complete
            ? item.error === undefined
              ? "succeeded"
              : "failed"
            : "running"}
        </span>
      </summary>
      <div className="voice-tool-event__body">
        {item.input === undefined ? null : (
          <CodeBlock
            code={JSON.stringify(item.input, null, 2)}
            label="Tool input"
            language="json"
          />
        )}
        {item.output === undefined && item.error === undefined ? null : (
          <CodeBlock
            code={JSON.stringify(item.error ?? item.output, null, 2)}
            label="Tool result"
            language="json"
          />
        )}
        <a
          href={`/${encodeURIComponent(project)}/executions?execution=${encodeURIComponent(item.executionId)}`}
        >
          Open execution <code>{item.executionId}</code>
          <Icon name="arrowRight" />
        </a>
      </div>
    </details>
  );
}

interface OwnedNumberBinding {
  bindingId: string;
  agentId: string;
  revision: number;
}

interface OwnedNumber {
  numberId: string;
  phoneNumber: string;
  friendlyName: string;
  provider: string;
  bindingStatus: "bound" | "unbound";
  binding?: OwnedNumberBinding;
  createdAt: string;
}

function parseOwnedNumbers(value: unknown): readonly OwnedNumber[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = asRecord(entry, "Owned number");
    const binding =
      typeof record.binding === "object" &&
      record.binding !== null &&
      !Array.isArray(record.binding)
        ? (record.binding as Readonly<Record<string, unknown>>)
        : undefined;
    return {
      numberId: String(record.numberId),
      phoneNumber: String(record.phoneNumber),
      friendlyName: String(record.friendlyName),
      provider: String(record.provider),
      bindingStatus: record.bindingStatus === "bound" ? "bound" : "unbound",
      ...(binding === undefined
        ? {}
        : {
            binding: {
              bindingId: String(binding.bindingId),
              agentId: String(binding.agentId),
              revision: Number(binding.revision),
            },
          }),
      createdAt: String(record.createdAt),
    };
  });
}

export function VoiceNumbersSection({
  agents,
}: {
  agents: readonly VoiceAgentSummary[];
}) {
  const [numbers, setNumbers] = useState<readonly OwnedNumber[]>();
  const [message, setMessage] = useState<string>();
  const [buyPhoneNumber, setBuyPhoneNumber] = useState("");
  const [buyFriendlyName, setBuyFriendlyName] = useState("");
  const [attachTargets, setAttachTargets] = useState<
    Readonly<Record<string, string>>
  >({});
  const [busyAction, setBusyAction] = useState<string>();

  const loadNumbers = useCallback(async () => {
    try {
      const output = await runVoiceTool("twilio.list_numbers", {
        pageSize: 50,
      });
      setNumbers(parseOwnedNumbers(output.numbers));
      setMessage(undefined);
    } catch (error) {
      setNumbers([]);
      setMessage(
        error instanceof Error
          ? error.message
          : "Owned numbers could not be listed.",
      );
    }
  }, []);

  useEffect(() => {
    void loadNumbers();
  }, [loadNumbers]);

  async function runNumberAction(key: string, action: () => Promise<void>) {
    setBusyAction(key);
    setMessage(undefined);
    try {
      await action();
      await loadNumbers();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The action failed.");
    } finally {
      setBusyAction(undefined);
    }
  }

  async function buyNumber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneNumber = buyPhoneNumber.trim();
    if (phoneNumber.length === 0) return;
    await runNumberAction("buy", async () => {
      const friendlyName = buyFriendlyName.trim();
      await runVoiceTool(
        "twilio.buy_number",
        {
          phoneNumber,
          ...(friendlyName.length === 0 ? {} : { friendlyName }),
        },
        "sync",
        true,
      );
      setBuyPhoneNumber("");
      setBuyFriendlyName("");
    });
  }

  async function attachAgent(number: OwnedNumber) {
    const target = attachTargets[number.numberId];
    if (target === undefined || target.length === 0) {
      setMessage("Choose a published agent revision to attach.");
      return;
    }
    const [agentId, revisionValue] = target.split(":");
    await runNumberAction(`attach:${number.numberId}`, async () => {
      await runVoiceTool(
        "voice-agents.attach_agent_to_number",
        {
          agentId: agentId ?? "",
          revision: Number(revisionValue),
          phoneNumber: number.phoneNumber,
          transportConnectionId: await resolveTransportConnectionId("twilio"),
        },
        "sync",
        true,
      );
    });
  }

  async function detachNumber(number: OwnedNumber) {
    await runNumberAction(`detach:${number.numberId}`, async () => {
      await runVoiceTool(
        "voice-agents.detach_number",
        { phoneNumber: number.phoneNumber },
        "sync",
        true,
      );
    });
  }

  async function releaseNumber(number: OwnedNumber) {
    if (
      !window.confirm(
        `Release ${number.phoneNumber} back to the provider? Bound numbers must be detached first; release cannot be undone.`,
      )
    ) {
      return;
    }
    await runNumberAction(`release:${number.numberId}`, async () => {
      await runVoiceTool(
        "twilio.release_number",
        { phoneNumber: number.phoneNumber },
        "sync",
        true,
      );
    });
  }

  const agentLabel = (binding: OwnedNumberBinding): string => {
    const summary = agents.find(({ id }) => id === binding.agentId);
    return summary === undefined
      ? `${binding.agentId} r${binding.revision}`
      : `${summary.name} r${binding.revision}`;
  };

  return (
    <section aria-label="Owned telephone numbers" className="voice-numbers">
      <div className="voice-numbers__heading">
        <div>
          <p className="eyebrow">Inventory</p>
          <h2>Numbers</h2>
          <p>
            Provider-owned inbound numbers and their agent bindings.
            Reassignment is detach followed by attach; bound numbers cannot be
            released.
          </p>
        </div>
        <form className="voice-numbers__buy" onSubmit={buyNumber}>
          <Input
            label="Buy number (E.164)"
            mono
            onChange={(event) => setBuyPhoneNumber(event.currentTarget.value)}
            placeholder="+15005550006"
            value={buyPhoneNumber}
          />
          <Input
            label="Label"
            onChange={(event) => setBuyFriendlyName(event.currentTarget.value)}
            placeholder="Front desk"
            value={buyFriendlyName}
          />
          <Button
            disabled={busyAction === "buy" || buyPhoneNumber.trim() === ""}
            type="submit"
            variant="primary"
          >
            {busyAction === "buy" ? "Buying…" : "Buy number"}
          </Button>
        </form>
      </div>
      {message === undefined ? null : (
        <div className="inline-error" role="alert">
          <p>{message}</p>
        </div>
      )}
      {numbers === undefined ? (
        <p className="voice-numbers__empty">Loading owned numbers…</p>
      ) : numbers.length === 0 ? (
        <p className="voice-numbers__empty">
          No provider-owned numbers yet. Buy one above with a connected twilio
          account-free mock connection, then attach a published agent revision.
        </p>
      ) : (
        <TableShell
          caption="Provider-owned telephone numbers"
          columns={[
            { key: "number", label: "Number" },
            { key: "binding", label: "Binding" },
            { key: "created", label: "Created" },
            { key: "actions", label: "Actions" },
          ]}
        >
          {numbers.map((number) => (
            <tr key={number.numberId}>
              <td>
                <span className="webhook-endpoint-identity">
                  <span>
                    <strong className="mono">{number.phoneNumber}</strong>
                  </span>
                  <span>
                    <code>{number.friendlyName}</code>
                  </span>
                </span>
              </td>
              <td>
                {number.bindingStatus === "bound" && number.binding ? (
                  <code>{agentLabel(number.binding)}</code>
                ) : (
                  <code>unbound</code>
                )}
              </td>
              <td className="mono">{number.createdAt.slice(0, 10)}</td>
              <td>
                <span className="row-actions voice-numbers__actions">
                  {number.bindingStatus === "bound" ? (
                    <Button
                      disabled={busyAction !== undefined}
                      onClick={() => void detachNumber(number)}
                      size="small"
                      variant="secondary"
                    >
                      {busyAction === `detach:${number.numberId}`
                        ? "Detaching…"
                        : "Detach"}
                    </Button>
                  ) : (
                    <>
                      <select
                        aria-label={`Agent for ${number.phoneNumber}`}
                        className="field__control"
                        onChange={(event) =>
                          setAttachTargets((current) => ({
                            ...current,
                            [number.numberId]: event.currentTarget.value,
                          }))
                        }
                        value={attachTargets[number.numberId] ?? ""}
                      >
                        <option value="">Choose agent…</option>
                        {agents.map((agent) => (
                          <option
                            key={agent.id}
                            value={`${agent.id}:${agent.activeRevision}`}
                          >
                            {agent.name} r{agent.activeRevision}
                          </option>
                        ))}
                      </select>
                      <Button
                        disabled={busyAction !== undefined}
                        onClick={() => void attachAgent(number)}
                        size="small"
                        variant="secondary"
                      >
                        {busyAction === `attach:${number.numberId}`
                          ? "Attaching…"
                          : "Attach"}
                      </Button>
                    </>
                  )}
                  <Button
                    disabled={
                      busyAction !== undefined ||
                      number.bindingStatus === "bound"
                    }
                    onClick={() => void releaseNumber(number)}
                    size="small"
                    variant="danger"
                  >
                    {busyAction === `release:${number.numberId}`
                      ? "Releasing…"
                      : "Release"}
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </TableShell>
      )}
    </section>
  );
}

export function VoiceAgentsScreen({
  initialAgents,
  initialDefinitions = {},
  initialRevision,
  initialSelectedAgent,
  initialSessionId,
  initialSessionUserId,
  project,
  tools,
}: VoiceAgentsScreenProps) {
  const initialSessionLink = parseVoiceSessionLink(
    initialSessionId,
    initialSessionUserId,
  );
  const selectableTools = useMemo(
    () => tools.filter(({ name }) => !name.startsWith("voice-agents.")),
    [tools],
  );
  const [agents, setAgents] = useState<readonly VoiceAgentSummary[]>(
    initialAgents ?? [],
  );
  const [definitions, setDefinitions] =
    useState<Readonly<Record<string, VoiceAgentDefinition>>>(
      initialDefinitions,
    );
  const [selectedId, setSelectedId] = useState(
    initialSessionLink === undefined ? initialSelectedAgent : undefined,
  );
  const [selectedRevision, setSelectedRevision] = useState(
    initialSessionLink === undefined ? initialRevision : undefined,
  );
  const [createMode, setCreateMode] = useState(
    initialSelectedAgent === undefined && initialSessionLink === undefined,
  );
  const [listState, setListState] = useState<PanelState>(
    initialAgents === undefined ? "loading" : "ready",
  );
  const [listMessage, setListMessage] = useState<string>();
  const [builder, setBuilder] = useState<BuilderState>(() =>
    defaultBuilder(selectableTools),
  );
  const [builderError, setBuilderError] = useState<string>();
  const [builderNotice, setBuilderNotice] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  const [sessionCounts, setSessionCounts] = useState<
    Readonly<Record<string, number>>
  >({});
  const [session, setSession] = useState<VoiceSession>();
  const [events, setEvents] = useState<readonly VoiceSessionEvent[]>([]);
  const [artifact, setArtifact] = useState<TranscriptArtifact>();
  const [testState, setTestState] = useState<
    "error" | "idle" | "starting" | "watching"
  >("idle");
  const [testMessage, setTestMessage] = useState<string>();
  const [progressionAvailable, setProgressionAvailable] = useState(true);
  const [chatMessage, setChatMessage] = useState("");
  const [joinGrant, setJoinGrant] = useState<{
    expiresAt: string;
    participantToken: string;
    roomUrl: string;
  }>();
  const [sessionLink, setSessionLink] = useState<VoiceSessionLink | undefined>(
    initialSessionLink,
  );
  const [sessionLinkState, setSessionLinkState] = useState<
    "error" | "idle" | "loading" | "ready"
  >(initialSessionLink === undefined ? "idle" : "loading");
  const [sessionLinkMessage, setSessionLinkMessage] = useState<string>();
  const pollingRef = useRef(false);

  const selectedSummary = agents.find(({ id }) => id === selectedId);
  const definitionKey =
    selectedId === undefined
      ? undefined
      : `${selectedId}:${selectedRevision ?? selectedSummary?.activeRevision ?? "active"}`;
  const selectedDefinition =
    definitionKey === undefined ? undefined : definitions[definitionKey];

  const loadAgents = useCallback(async () => {
    setListState("loading");
    try {
      const listed = await runVoiceTool("voice-agents.list_voice_agents", {
        limit: 50,
      });
      const nextAgents = (listed.agents ?? []) as readonly VoiceAgentSummary[];
      setAgents(nextAgents);
      const loadedDefinitions = await Promise.all(
        nextAgents.map(async (summary) => {
          const output = await runVoiceTool("voice-agents.get_voice_agent", {
            agentId: summary.id,
            revision: summary.activeRevision,
          });
          return [
            `${summary.id}:${summary.activeRevision}`,
            parseAgent(output.agent),
          ] as const;
        }),
      );
      setDefinitions((current) => ({
        ...current,
        ...Object.fromEntries(loadedDefinitions),
      }));
      try {
        const sessionPage = await runVoiceTool(
          "voice-agents.list_agent_sessions",
          { limit: 100 },
        );
        const counts: Record<string, number> = {};
        for (const value of (sessionPage.sessions ??
          []) as readonly VoiceSession[]) {
          counts[value.agentId] = (counts[value.agentId] ?? 0) + 1;
        }
        setSessionCounts(counts);
      } catch {
        setSessionCounts({});
      }
      setListState("ready");
      setListMessage(undefined);
      if (
        selectedId === undefined &&
        nextAgents[0] !== undefined &&
        !createMode &&
        sessionLink === undefined
      ) {
        setSelectedId(nextAgents[0].id);
      }
    } catch (error) {
      setListState(requestState(error));
      setListMessage(
        error instanceof Error
          ? error.message
          : "Voice agents could not be loaded.",
      );
    }
  }, [createMode, selectedId, sessionLink]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    if (sessionLink === undefined) {
      setSessionLinkState("idle");
      setSessionLinkMessage(undefined);
      return;
    }
    let cancelled = false;
    setSessionLinkState("loading");
    setSessionLinkMessage(undefined);
    void hydrateVoiceSessionLink({ project, ...sessionLink })
      .then((hydrated) => {
        if (cancelled) return;
        const linkedSession = parseSession(hydrated.session);
        const linkedAgent = parseAgent(hydrated.agent);
        const key = `${linkedAgent.id}:${linkedAgent.revision}`;
        setDefinitions((current) => ({ ...current, [key]: linkedAgent }));
        setSelectedId(linkedAgent.id);
        setSelectedRevision(linkedAgent.revision);
        setBuilder(builderFromAgent(linkedAgent));
        setCreateMode(false);
        setSession(linkedSession);
        setEvents(hydrated.events as readonly VoiceSessionEvent[]);
        setArtifact(
          hydrated.artifact === undefined
            ? undefined
            : (hydrated.artifact as TranscriptArtifact),
        );
        setJoinGrant(undefined);
        setTestState("idle");
        setTestMessage(undefined);
        setSessionLinkState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSessionLinkState("error");
        setSessionLinkMessage(
          error instanceof Error
            ? error.message
            : "The linked voice session could not be opened.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [project, sessionLink]);

  useEffect(() => {
    if (selectedId === undefined || selectedSummary === undefined) return;
    const revision = selectedRevision ?? selectedSummary.activeRevision;
    const key = `${selectedId}:${revision}`;
    const existing = definitions[key];
    if (existing !== undefined) {
      setBuilder(builderFromAgent(existing));
      return;
    }
    void runVoiceTool("voice-agents.get_voice_agent", {
      agentId: selectedId,
      revision,
    })
      .then((output) => {
        const agent = parseAgent(output.agent);
        setDefinitions((current) => ({ ...current, [key]: agent }));
        setBuilder(builderFromAgent(agent));
      })
      .catch((error: unknown) =>
        setBuilderError(
          error instanceof Error
            ? error.message
            : "Revision could not be loaded.",
        ),
      );
  }, [definitions, selectedId, selectedRevision, selectedSummary]);

  useEffect(() => {
    function popstate() {
      const query = new URL(window.location.href).searchParams;
      const linked = parseVoiceSessionLink(
        query.get("session"),
        query.get("userId"),
      );
      setSessionLink(linked);
      if (linked !== undefined) {
        setSelectedId(undefined);
        setSelectedRevision(undefined);
        setCreateMode(false);
        setSession(undefined);
        setEvents([]);
        setArtifact(undefined);
        return;
      }
      const agentId = query.get("agent") ?? undefined;
      const revision = Number(query.get("revision"));
      setSession(undefined);
      setEvents([]);
      setArtifact(undefined);
      setJoinGrant(undefined);
      setTestState("idle");
      setSelectedId(agentId);
      setSelectedRevision(
        Number.isSafeInteger(revision) && revision > 0 ? revision : undefined,
      );
      setCreateMode(query.get("new") === "true" || agentId === undefined);
    }
    window.addEventListener("popstate", popstate);
    return () => window.removeEventListener("popstate", popstate);
  }, []);

  const refreshSession = useCallback(
    async (activeSession: VoiceSession, advance = true) => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        if (advance && !terminalSession(activeSession.state)) {
          try {
            await dashboardExecutorClient(
              activeSession.projectId,
            ).advanceVoiceSession(activeSession.id, {
              userId: activeSession.userId,
              milliseconds: 1_000,
            });
            setProgressionAvailable(true);
          } catch (error) {
            if (
              error instanceof ExecutorApiError &&
              (error.status === 404 || error.status === 502)
            ) {
              setProgressionAvailable(false);
            } else {
              throw error;
            }
          }
        }
        const [sessionOutput, transcriptOutput] = await Promise.all([
          runVoiceTool(
            "voice-agents.get_agent_session",
            {
              sessionId: activeSession.id,
              afterSequence: 0,
              eventLimit: 200,
            },
            "sync",
            false,
            {
              project: activeSession.projectId,
              userId: activeSession.userId,
            },
          ),
          runVoiceTool(
            "voice-agents.get_session_transcript",
            { sessionId: activeSession.id },
            "sync",
            false,
            {
              project: activeSession.projectId,
              userId: activeSession.userId,
            },
          ),
        ]);
        const nextSession = parseSession(sessionOutput.session);
        setSession(nextSession);
        setEvents((sessionOutput.events ?? []) as readonly VoiceSessionEvent[]);
        setArtifact(transcriptOutput.artifact as TranscriptArtifact);
        if (terminalSession(nextSession.state)) setTestState("idle");
        setTestMessage(undefined);
      } catch (error) {
        setTestState("error");
        setTestMessage(
          error instanceof Error ? error.message : "Session polling failed.",
        );
      } finally {
        pollingRef.current = false;
      }
    },
    [],
  );

  useEffect(() => {
    if (testState !== "watching" || session === undefined) return;
    const interval = window.setInterval(
      () => void refreshSession(session),
      SESSION_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [refreshSession, session, testState]);

  function selectAgent(agent: VoiceAgentSummary) {
    setSessionLink(undefined);
    setSelectedId(agent.id);
    setSelectedRevision(agent.activeRevision);
    setCreateMode(false);
    setBuilderError(undefined);
    setBuilderNotice(undefined);
    setSession(undefined);
    setEvents([]);
    window.history.pushState(
      null,
      "",
      voiceUrl(agent.id, agent.activeRevision),
    );
  }

  function createAgent() {
    setSessionLink(undefined);
    setCreateMode(true);
    setSelectedId(undefined);
    setSelectedRevision(undefined);
    setBuilder(defaultBuilder(selectableTools));
    setBuilderError(undefined);
    setBuilderNotice(undefined);
    setSession(undefined);
    setEvents([]);
    window.history.pushState(null, "", voiceUrl(undefined, undefined, true));
  }

  async function submitBuilder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBuilderError(undefined);
    setBuilderNotice(undefined);
    const duration = Number(builder.maxDurationSeconds);
    if (
      builder.name.trim() === "" ||
      builder.systemPrompt.trim() === "" ||
      builder.llmModel.trim() === ""
    ) {
      setBuilderError(
        "Name, system prompt, and LLM model reference are required.",
      );
      return;
    }
    if (!Number.isSafeInteger(duration) || duration < 30 || duration > 7_200) {
      setBuilderError(
        "Maximum duration must be an integer from 30 through 7200 seconds.",
      );
      return;
    }
    if (builder.tools.length === 0) {
      setBuilderError(
        "Select at least one canonical tool for the agent allowlist.",
      );
      return;
    }
    setSaving(true);
    try {
      const draft = draftFromBuilder(builder);
      const output =
        createMode || selectedSummary === undefined
          ? await runVoiceTool(
              "voice-agents.create_voice_agent",
              { agent: draft },
              "sync",
              true,
            )
          : await runVoiceTool(
              "voice-agents.update_voice_agent",
              {
                agentId: selectedSummary.id,
                expectedRevision: selectedSummary.activeRevision,
                agent: draft,
              },
              "sync",
              true,
            );
      const agent = parseAgent(output.agent);
      setSelectedId(agent.id);
      setSelectedRevision(agent.revision);
      setCreateMode(false);
      setDefinitions((current) => ({
        ...current,
        [`${agent.id}:${agent.revision}`]: agent,
      }));
      setBuilderNotice(
        agent.revision === 1
          ? `Created ${agent.name} at immutable revision 1.`
          : `Published immutable revision ${agent.revision}.`,
      );
      setSessionLink(undefined);
      window.history.replaceState(null, "", voiceUrl(agent.id, agent.revision));
      await loadAgents();
    } catch (error) {
      setBuilderError(
        error instanceof Error
          ? error.message
          : "Voice agent could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  function chooseRevision(revision: number) {
    if (selectedId === undefined) return;
    setSessionLink(undefined);
    setSelectedRevision(revision);
    window.history.pushState(null, "", voiceUrl(selectedId, revision));
  }

  function toggleTool(name: string) {
    setBuilder((current) => ({
      ...current,
      tools: current.tools.includes(name)
        ? current.tools.filter((tool) => tool !== name)
        : [...current.tools, name],
    }));
  }

  async function startTestCall() {
    if (selectedDefinition === undefined) return;
    setTestState("starting");
    setTestMessage(undefined);
    setEvents([]);
    setArtifact(undefined);
    try {
      const output = await runVoiceTool(
        "voice-agents.start_agent_call",
        {
          agentId: selectedDefinition.id,
          revision: selectedDefinition.revision,
          to: "+966500000111",
          from: "+966500000222",
          transportConnectionId: await resolveTransportConnectionId("twilio"),
          script: RESERVATION_SCRIPT,
        },
        "async",
        true,
      );
      const nextSession = parseSession(output.session);
      setSession(nextSession);
      setTestState("watching");
      await refreshSession(nextSession);
    } catch (error) {
      setTestState("error");
      setTestMessage(
        error instanceof Error
          ? error.message
          : "The test call could not start.",
      );
    }
  }

  async function startWebSession() {
    if (selectedDefinition === undefined) return;
    setTestState("starting");
    setTestMessage(undefined);
    setEvents([]);
    setArtifact(undefined);
    setJoinGrant(undefined);
    try {
      const output = await runVoiceTool(
        "voice-agents.create_web_session",
        {
          agentId: selectedDefinition.id,
          revision: selectedDefinition.revision,
          transportConnectionId: await resolveTransportConnectionId("livekit"),
          participantIdentity: DASHBOARD_USER_ID,
          participantName: "Dashboard test participant",
        },
        "sync",
        true,
      );
      const nextSession = parseSession(output.session);
      const grant = output.joinGrant;
      if (
        typeof grant === "object" &&
        grant !== null &&
        !Array.isArray(grant)
      ) {
        const record = grant as Record<string, unknown>;
        if (
          typeof record.roomUrl === "string" &&
          typeof record.participantToken === "string" &&
          typeof record.expiresAt === "string"
        ) {
          setJoinGrant({
            expiresAt: record.expiresAt,
            participantToken: record.participantToken,
            roomUrl: record.roomUrl,
          });
        }
      }
      setSession(nextSession);
      setTestState("watching");
      await refreshSession(nextSession);
    } catch (error) {
      setTestState("error");
      setTestMessage(
        error instanceof Error
          ? error.message
          : "The web session could not be created.",
      );
    }
  }

  async function endCall() {
    if (session === undefined) return;
    try {
      await dashboardExecutorClient(session.projectId).advanceVoiceSession(
        session.id,
        {
          userId: session.userId,
          milliseconds: 1_000,
          end: true,
        },
      );
      await refreshSession(session, false);
      setTestState("idle");
    } catch (error) {
      setTestState("error");
      setTestMessage(
        error instanceof Error ? error.message : "The test call could not end.",
      );
    }
  }

  async function sendChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedDefinition === undefined || chatMessage.trim() === "") return;
    const continuingSessionId =
      session !== undefined && !terminalSession(session.state)
        ? session.id
        : undefined;
    setTestState("starting");
    setTestMessage(undefined);
    if (continuingSessionId === undefined) {
      setEvents([]);
      setArtifact(undefined);
    }
    try {
      const output = await runVoiceTool(
        "voice-agents.send_session_message",
        {
          agentId: selectedDefinition.id,
          revision: selectedDefinition.revision,
          message: chatMessage.trim(),
          clientMessageId: `dashboard_${crypto.randomUUID()}`,
          ...(continuingSessionId === undefined
            ? {}
            : { sessionId: continuingSessionId }),
        },
        "async",
        true,
        continuingSessionId === undefined || session === undefined
          ? { project, userId: DASHBOARD_USER_ID }
          : { project: session.projectId, userId: session.userId },
      );
      const nextSession = parseSession(output.session);
      setSession(nextSession);
      setChatMessage("");
      setTestState("watching");
      await refreshSession(nextSession);
    } catch (error) {
      setTestState("error");
      setTestMessage(
        error instanceof Error ? error.message : "Message could not be sent.",
      );
    }
  }

  const matchingTools = useMemo(() => {
    const query = toolQuery.trim().toLocaleLowerCase("en");
    return selectableTools
      .filter(({ name, capability, toolkit }) =>
        query === ""
          ? true
          : `${name} ${capability} ${toolkit}`
              .toLocaleLowerCase("en")
              .includes(query),
      )
      .slice(0, 10);
  }, [selectableTools, toolQuery]);
  const transcript = useMemo(() => projectTranscriptEvents(events), [events]);
  const activeRevision = selectedSummary?.activeRevision;

  return (
    <main className="page-stack voice-agents-page">
      <PageHeader
        actions={
          <Button
            icon={<Icon name="plus" />}
            onClick={createAgent}
            variant="primary"
          >
            Create agent
          </Button>
        }
        description="Compose immutable voice-agent revisions and exercise their real tool allowlist against the deterministic session worker."
        eyebrow={`Project / ${project}`}
        title="Voice Agents"
      />

      {sessionLink === undefined ? null : (
        <div
          aria-live="polite"
          className={
            sessionLinkState === "error"
              ? "offline-banner"
              : "offline-banner offline-banner--warning"
          }
        >
          <Icon name="voice" />
          <div>
            <strong>
              {sessionLinkState === "loading"
                ? "Opening linked voice session"
                : sessionLinkState === "error"
                  ? "Linked voice session could not be opened"
                  : "Linked voice session opened"}
            </strong>
            <p>
              {sessionLinkMessage ??
                `Session ${sessionLink.sessionId} for ${sessionLink.userId}`}
            </p>
          </div>
          {sessionLinkState === "error" ? (
            <Button
              onClick={() => setSessionLink({ ...sessionLink })}
              size="small"
              variant="secondary"
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}

      {listState !== "ready" && listState !== "loading" ? (
        <div
          className={
            listState === "unconfigured"
              ? "offline-banner offline-banner--warning"
              : "offline-banner"
          }
        >
          <Icon name="voice" />
          <div>
            <strong>
              {listState === "unconfigured"
                ? "Executor authentication is not configured"
                : "Voice-agent runtime is unavailable"}
            </strong>
            <p>{listMessage}</p>
          </div>
          <Button
            onClick={() => void loadAgents()}
            size="small"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : null}

      <div className="voice-workbench">
        <section
          aria-label="Voice agent builder"
          className="voice-builder-column"
        >
          <div className="voice-agent-list-header">
            <div>
              <p className="eyebrow">Agent registry</p>
              <h2>
                {listState === "loading"
                  ? "Loading agents…"
                  : `${agents.length} agent${agents.length === 1 ? "" : "s"}`}
              </h2>
            </div>
            <Button onClick={createAgent} size="small" variant="ghost">
              New
            </Button>
          </div>

          <div className="voice-agent-list">
            {agents.length === 0 && listState === "ready" ? (
              <button
                className="voice-agent-empty"
                onClick={createAgent}
                type="button"
              >
                <Icon name="voice" />
                <strong>Create your first agent</strong>
                <span>
                  Start from the reservation fixture and publish revision 1.
                </span>
              </button>
            ) : (
              agents.map((agent) => {
                const active = selectedId === agent.id && !createMode;
                const definition =
                  definitions[`${agent.id}:${agent.activeRevision}`];
                return (
                  <button
                    aria-pressed={active}
                    className="voice-agent-card"
                    key={agent.id}
                    onClick={() => selectAgent(agent)}
                    type="button"
                  >
                    <span className="voice-agent-card__topline">
                      <strong>{agent.name}</strong>
                      <span className="transport-chip">
                        {transportLabel(agent.transport)}
                      </span>
                    </span>
                    <code>{agent.id}</code>
                    <span className="voice-agent-card__stats">
                      <span>rev {agent.activeRevision}</span>
                      <span>{definition?.tools.length ?? "—"} tools</span>
                      <span>{sessionCounts[agent.id] ?? 0} sessions</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <form className="voice-builder-form" onSubmit={submitBuilder}>
            <div className="voice-builder-form__heading">
              <div>
                <p className="eyebrow">
                  {createMode ? "New definition" : "Edit as new revision"}
                </p>
                <h2>
                  {createMode
                    ? "Create voice agent"
                    : builder.name || "Voice agent"}
                </h2>
              </div>
              {createMode || activeRevision === undefined ? null : (
                <fieldset className="revision-strip">
                  <legend className="visually-hidden">Revision history</legend>
                  {Array.from(
                    { length: activeRevision },
                    (_, index) => index + 1,
                  ).map((revision) => (
                    <button
                      aria-label={`Load revision ${revision}`}
                      aria-pressed={
                        (selectedRevision ?? activeRevision) === revision
                      }
                      key={revision}
                      onClick={() => chooseRevision(revision)}
                      type="button"
                    >
                      r{revision}
                    </button>
                  ))}
                </fieldset>
              )}
            </div>

            <div className="voice-form-grid">
              <Input
                label="Name"
                onChange={(event) =>
                  setBuilder((value) => ({
                    ...value,
                    name: event.target.value,
                  }))
                }
                value={builder.name}
              />
              <Input
                label="LLM model ref"
                mono
                onChange={(event) =>
                  setBuilder((value) => ({
                    ...value,
                    llmModel: event.target.value,
                  }))
                }
                value={builder.llmModel}
              />
            </div>
            <label className="voice-textarea-field">
              <span>System prompt</span>
              <textarea
                className="mono"
                onChange={(event) =>
                  setBuilder((value) => ({
                    ...value,
                    systemPrompt: event.target.value,
                  }))
                }
                rows={7}
                value={builder.systemPrompt}
              />
              <small>Pinned into every immutable revision.</small>
            </label>

            <fieldset className="voice-builder-section">
              <legend>Voice and transport</legend>
              <div className="voice-form-grid voice-form-grid--three">
                <Select
                  label="TTS voice"
                  onChange={(event) =>
                    setBuilder((value) => ({
                      ...value,
                      voiceId: event.target.value,
                    }))
                  }
                  options={FIXTURE_VOICES}
                  value={builder.voiceId}
                />
                <Input
                  label="STT model ref"
                  mono
                  onChange={(event) =>
                    setBuilder((value) => ({
                      ...value,
                      sttModel: event.target.value,
                    }))
                  }
                  value={builder.sttModel}
                />
                <Select
                  label="Transport"
                  onChange={(event) =>
                    setBuilder((value) => ({
                      ...value,
                      transport: event.target.value as VoiceAgentTransport,
                    }))
                  }
                  options={[
                    { label: "PSTN · Twilio", value: "pstn:twilio" },
                    { label: "WebRTC · LiveKit", value: "webrtc:livekit" },
                    { label: "Chat", value: "chat" },
                  ]}
                  value={builder.transport}
                />
              </div>
            </fieldset>

            <fieldset className="voice-builder-section">
              <legend>Canonical tool allowlist</legend>
              <div className="tool-multiselect">
                <label className="tool-multiselect__search">
                  <Icon name="search" />
                  <span className="visually-hidden">
                    Search canonical tools
                  </span>
                  <input
                    onChange={(event) => setToolQuery(event.target.value)}
                    placeholder="Search local catalog…"
                    type="search"
                    value={toolQuery}
                  />
                  <span>{matchingTools.length}</span>
                </label>
                <div className="tool-multiselect__options">
                  {matchingTools.map((tool) => (
                    <button
                      aria-pressed={builder.tools.includes(tool.name)}
                      key={tool.name}
                      onClick={() => toggleTool(tool.name)}
                      type="button"
                    >
                      <code>{tool.name}</code>
                      <span>
                        {builder.tools.includes(tool.name)
                          ? "Selected"
                          : tool.capability}
                      </span>
                    </button>
                  ))}
                </div>
                <fieldset className="selected-tool-chips">
                  <legend className="visually-hidden">
                    Selected canonical tools
                  </legend>
                  {builder.tools.map((tool) => (
                    <button
                      key={tool}
                      onClick={() => toggleTool(tool)}
                      type="button"
                    >
                      <code>{tool}</code>
                      <Icon name="close" />
                    </button>
                  ))}
                </fieldset>
              </div>
            </fieldset>

            <fieldset className="voice-builder-section">
              <legend>Guardrails</legend>
              <Input
                label="Maximum duration (seconds)"
                max={7200}
                min={30}
                onChange={(event) =>
                  setBuilder((value) => ({
                    ...value,
                    maxDurationSeconds: event.target.value,
                  }))
                }
                type="number"
                value={builder.maxDurationSeconds}
              />
            </fieldset>

            {builderError === undefined ? null : (
              <div className="inline-error">
                <p>{builderError}</p>
              </div>
            )}
            {builderNotice === undefined ? null : (
              <div className="voice-success-notice">
                <Icon name="check" />
                <p>{builderNotice}</p>
              </div>
            )}
            <div className="voice-builder-form__actions">
              <span>
                {createMode
                  ? "Creates revision 1"
                  : `Publishes after r${activeRevision ?? "—"}`}
              </span>
              <Button disabled={saving} type="submit" variant="primary">
                {saving
                  ? "Publishing…"
                  : createMode
                    ? "Create agent"
                    : "Publish new revision"}
              </Button>
            </div>
          </form>
        </section>

        <aside aria-label="Live voice agent test" className="voice-test-panel">
          <header className="voice-test-panel__header">
            <div>
              <p className="eyebrow">Live test panel</p>
              <h2>{selectedDefinition?.name ?? "Select a saved agent"}</h2>
              <p>
                {selectedDefinition === undefined
                  ? "Publish a revision to begin."
                  : `${transportLabel(selectedDefinition.transport)} · revision ${selectedDefinition.revision}`}
              </p>
            </div>
            {session === undefined ? null : (
              <span
                className={`session-state-pill session-state-pill--${session.state}`}
              >
                <span
                  aria-hidden="true"
                  className={
                    testState === "watching" && !terminalSession(session.state)
                      ? "is-watching"
                      : undefined
                  }
                />
                {session.state}
              </span>
            )}
          </header>

          <div className="voice-test-panel__controls">
            {selectedDefinition?.transport === "pstn:twilio" ? (
              session === undefined || terminalSession(session.state) ? (
                <Button
                  disabled={testState === "starting"}
                  icon={<Icon name="voice" />}
                  onClick={() => void startTestCall()}
                  variant="primary"
                >
                  {testState === "starting" ? "Connecting…" : "Start test call"}
                </Button>
              ) : (
                <Button onClick={() => void endCall()} variant="danger">
                  End call
                </Button>
              )
            ) : selectedDefinition?.transport === "chat" ? (
              <form className="chat-test-form" onSubmit={sendChat}>
                <input
                  aria-label="Test chat message"
                  onChange={(event) => setChatMessage(event.target.value)}
                  placeholder="Type a caller message…"
                  value={chatMessage}
                />
                <Button
                  disabled={
                    testState === "starting" || chatMessage.trim() === ""
                  }
                  type="submit"
                  variant="primary"
                >
                  Send
                </Button>
              </form>
            ) : selectedDefinition?.transport === "webrtc:livekit" ? (
              session === undefined || terminalSession(session.state) ? (
                <Button
                  disabled={testState === "starting"}
                  icon={<Icon name="voice" />}
                  onClick={() => void startWebSession()}
                  variant="primary"
                >
                  {testState === "starting"
                    ? "Creating session…"
                    : "Create web session"}
                </Button>
              ) : (
                <Button onClick={() => void endCall()} variant="danger">
                  End session
                </Button>
              )
            ) : (
              <p className="voice-test-panel__prompt">
                Choose an agent card or create and publish a revision.
              </p>
            )}
          </div>

          {joinGrant !== undefined ? (
            <div className="voice-join-grant" role="note">
              <strong>Short-lived join grant</strong>
              <p>
                Room <code>{joinGrant.roomUrl}</code>
                <CopyButton label="Copy room URL" value={joinGrant.roomUrl} />
              </p>
              <p>
                Participant token expires {joinGrant.expiresAt}
                <CopyButton
                  label="Copy participant token"
                  value={joinGrant.participantToken}
                />
              </p>
              <small>
                The join grant appears only in this create response; provider
                API secrets never enter session output. Dismissing discards it.
              </small>
              <Button
                onClick={() => setJoinGrant(undefined)}
                size="small"
                variant="secondary"
              >
                Dismiss grant
              </Button>
            </div>
          ) : null}

          {!progressionAvailable &&
          session !== undefined &&
          !terminalSession(session.state) ? (
            <div className="voice-runtime-note voice-runtime-note--warning">
              <strong>Automatic mock-clock progression is unavailable</strong>
              <p>
                The session is still polled. Start the executor with its dev
                voice-session runtime to drive the scripted demo.
              </p>
            </div>
          ) : null}
          {testMessage === undefined ? null : (
            <div className="inline-error">
              <p>{testMessage}</p>
            </div>
          )}

          <div aria-live="polite" className="voice-transcript">
            {transcript.length === 0 ? (
              <div className="voice-transcript__empty">
                <span className="voice-orb">
                  <span />
                  <span />
                  <span />
                </span>
                <strong>
                  {testState === "starting"
                    ? "Opening the fixture transport…"
                    : "Ready for a test session"}
                </strong>
                <p>
                  PSTN runs the reservation caller script; chat accepts a
                  message above.
                </p>
              </div>
            ) : (
              transcript.map((item) =>
                item.kind === "tool" ? (
                  <ToolEvent item={item} key={item.key} project={project} />
                ) : (
                  <article
                    className={`voice-turn voice-turn--${item.speaker}`}
                    key={item.key}
                  >
                    <span>
                      {item.speaker === "caller" ? "Caller" : "Agent"}
                    </span>
                    <p>{item.text}</p>
                    {!item.final ? <i>streaming</i> : null}
                  </article>
                ),
              )
            )}
          </div>

          <footer className="voice-test-panel__footer">
            <span className="mono">{session?.id ?? "no session"}</span>
            <span>
              {events.length} events · {artifact?.turns.length ?? 0} transcript
              turns{artifact?.final ? " · final" : ""}
            </span>
          </footer>
        </aside>
      </div>
      <VoiceNumbersSection agents={agents} />
    </main>
  );
}
