export interface RouteScaffoldContent {
  action: string;
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  eyebrow: string;
  previewLabel: string;
  snippet: string;
  title: string;
}

export const routeContent = {
  toolkits: {
    action: "Enable toolkit",
    description:
      "Browse the local catalog, inspect canonical tools and schemas, and control project enablement from one exact inventory.",
    emptyDescription:
      "Start with the local catalog. Toolkit data is already typed and available without contacting the executor.",
    emptyTitle: "No toolkits enabled yet",
    eyebrow: "Capability catalog",
    previewLabel: "Catalog grid and toolkit inspector",
    snippet: `import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const { tools } = await eb.tools.get({
  capability: "email",
  toolkits: ["gmail"],
});`,
    title: "Toolkits",
  },
  connections: {
    action: "Create test link",
    description:
      "Inspect end-user accounts by external user and toolkit, with precise expiry, scope, and recovery state.",
    emptyDescription:
      "Create a hosted connect link for one external user. The SDK userId maps to external_user_id in the control plane.",
    emptyTitle: "No connected accounts",
    eyebrow: "Operational identity",
    previewLabel: "Connection account matrix",
    snippet: `import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

const connection = await eb.connections.create({
  userId: "user_123",
  toolkit: "gmail",
});`,
    title: "Connections",
  },
  "voice-agents": {
    action: "Build with mocks",
    description:
      "Define immutable voice-agent revisions, test them against mocks, and trace sessions back to ordinary tool executions.",
    emptyDescription:
      "Build and test a portable definition with the mock runtime first. No telephony or model-provider account is required.",
    emptyTitle: "No voice agents defined",
    eyebrow: "Definitions and sessions",
    previewLabel: "Definition builder and live test panel",
    snippet: `const draft = {
  name: "Table host",
  systemPrompt: "Confirm time, party size, and email.",
  llm: { model: "project/default-conversation" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "warm-host" },
    stt: { provider: "deepgram" },
  },
  transport: "chat",
  tools: ["google-calendar.create_event"],
  guardrails: {
    maxDurationSeconds: 600,
    handoffToHuman: { enabled: false },
  },
  webhooks: { endpointIds: [], transcript: true, events: [] },
  recordingPolicy: {
    mode: "disabled",
    consent: "external",
    retentionDays: 0,
    redactDtmf: true,
  },
};

await eb.tools.execute("voice-agents.create_voice_agent", {
  userId: "user_123",
  input: { agent: draft },
});`,
    title: "Voice Agents",
  },
  executions: {
    action: "Open request guide",
    description:
      "Follow every invocation from validation through provider response with normalized errors, exact timing, and inspectable I/O.",
    emptyDescription:
      "Run one authenticated tool call. Its execution ID becomes the stable handle for status, output, and recovery detail.",
    emptyTitle: "No executions recorded",
    eyebrow: "Invocation log",
    previewLabel: "Streaming execution table and inspector",
    snippet: `const result = await eb.tools.execute("gmail.send_email", {
  userId: "user_123",
  input: {
    to: ["agent@example.com"],
    subject: "First eyeball call",
    text: "The executor is connected.",
  },
});

const execution = await eb.executions.get(result.executionId);`,
    title: "Executions",
  },
  "api-keys": {
    action: "Create API key",
    description:
      "Create project-scoped credentials, reveal secrets once, and track prefixes, rotation, revocation, and last use.",
    emptyDescription:
      "Create a project key, store the secret in your runtime, and pass it only from trusted server-side code.",
    emptyTitle: "No API keys created",
    eyebrow: "Project access",
    previewLabel: "Scoped keys and reveal-once flow",
    snippet: `import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
  userId: "user_123",
});

const { tools } = await eb.tools.get();`,
    title: "API Keys",
  },
  settings: {
    action: "Configure project",
    description:
      "Keep the project profile, environment, auth configuration, endpoints, and membership in one operational context.",
    emptyDescription:
      "Point the SDK at this environment's executor URL. Hosted auth configuration will appear here when cloud data is wired.",
    emptyTitle: "Project configuration is untouched",
    eyebrow: "Project control",
    previewLabel: "Profile and environment settings",
    snippet: `import { Eyeball } from "@eyeball/sdk";

export const eb = new Eyeball({
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
  apiKey: process.env.EYEBALL_API_KEY!,
  userId: "user_123",
});`,
    title: "Settings",
  },
} satisfies Record<string, RouteScaffoldContent>;
