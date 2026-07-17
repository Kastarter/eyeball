import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createExecutionId,
  type ExecutionId,
  isExecutionId,
  MockCredentialProvider,
  type QualifiedToolName,
} from "@eyeball/core";
import {
  createMockApp,
  type ProviderMock,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import {
  createGmailMock,
  type GmailMessage,
} from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createSlackMock,
  type SlackMessage,
  slackFixtures,
} from "../../../mocks/packages/mocks-messaging/dist/index.js";
import {
  createGitHubMock,
  type GitHubIssue,
  githubFixtures,
} from "../../../mocks/packages/mocks-productivity/dist/index.js";
import {
  createExecutorApp,
  ExecutionEngine,
} from "../../executor/src/index.js";
import {
  createMcpGatewayApp,
  MCP_PROTOCOL_VERSION,
  type ToolDiscoveryMode,
} from "../src/index.js";

export const MCP_DEMO_API_KEY = "ey_test_agent_loop";
export const MCP_DEMO_PROJECT_ID = "proj_agent_loop";
export const MCP_DEMO_USER_ID = "user_agent_loop";

const MOCK_ORIGIN = "http://mockhouse.agent-loop.test";
const EXECUTOR_ORIGIN = "https://executor.agent-loop.test";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export interface McpToolResult {
  structuredContent?: Readonly<Record<string, unknown>>;
  isError?: true;
  content?: readonly { type: "text"; text: string }[];
  _meta?: {
    "dev.eyeball/execution"?: { executionId?: string };
  };
}

export interface ListedMcpTool {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export class InProcessMcpClient {
  readonly calledNames: string[] = [];
  readonly #app: ReturnType<typeof createMcpGatewayApp>;
  #requestSequence = 0;
  #sessionId: string | undefined;

  constructor(app: ReturnType<typeof createMcpGatewayApp>) {
    this.#app = app;
  }

  async initialize(): Promise<void> {
    await this.#request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "eyeball-demo-agent", version: "1.0.0" },
    });
    if (this.#sessionId === undefined) {
      throw new Error("MCP initialize did not allocate a session ID.");
    }
  }

  async listTools(): Promise<readonly ListedMcpTool[]> {
    const result = (await this.#request("tools/list", {})) as {
      tools?: unknown;
    };
    if (!Array.isArray(result.tools)) {
      throw new Error("MCP tools/list returned an invalid result.");
    }
    return result.tools.map((tool) => {
      if (
        typeof tool !== "object" ||
        tool === null ||
        !("name" in tool) ||
        typeof tool.name !== "string" ||
        !("description" in tool) ||
        typeof tool.description !== "string" ||
        !("inputSchema" in tool) ||
        typeof tool.inputSchema !== "object" ||
        tool.inputSchema === null ||
        Array.isArray(tool.inputSchema)
      ) {
        throw new Error("MCP tools/list returned an invalid tool descriptor.");
      }
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
      };
    });
  }

  async search(query: string): Promise<readonly string[]> {
    const result = await this.call("eyeball.search_tools", {
      query,
      limit: 10,
    });
    const tools = result.structuredContent?.tools;
    if (!Array.isArray(tools)) {
      throw new Error("eyeball.search_tools returned an invalid result.");
    }
    return tools.flatMap((tool) =>
      typeof tool === "object" &&
      tool !== null &&
      "name" in tool &&
      typeof tool.name === "string"
        ? [tool.name]
        : [],
    );
  }

  async call(
    name: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult> {
    const result = await this.callRaw(name, input);
    if (result.isError === true) {
      throw new Error(
        `MCP tool ${name} returned an error: ${result.content?.[0]?.text ?? "unknown error"}`,
      );
    }
    return result;
  }

  async callRaw(
    name: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<McpToolResult> {
    this.calledNames.push(name);
    const result = (await this.#request("tools/call", {
      name,
      arguments: input,
    })) as McpToolResult;
    return result;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    this.#requestSequence += 1;
    const response = await this.#app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MCP_DEMO_API_KEY}`,
        "Content-Type": "application/json",
        ...(this.#sessionId === undefined
          ? {}
          : { "Mcp-Session-Id": this.#sessionId }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `demo-${this.#requestSequence}`,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(`MCP request failed with HTTP ${response.status}.`);
    }
    this.#sessionId ??= response.headers.get("Mcp-Session-Id") ?? undefined;
    const body = (await response.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error !== undefined) {
      throw new Error(body.error.message ?? "MCP request failed.");
    }
    return body.result;
  }
}

function storeRecords<T extends object>(
  provider: ProviderMock,
  name: string,
): Array<T & { id: string }> {
  const snapshot = provider.stores[name]?.snapshot() as
    | { records?: Array<T & { id: string }> }
    | undefined;
  if (!Array.isArray(snapshot?.records)) {
    throw new Error(`Missing or invalid ${provider.slug}.${name} store.`);
  }
  return snapshot.records;
}

function executionId(result: McpToolResult): ExecutionId {
  const id = result._meta?.["dev.eyeball/execution"]?.executionId;
  if (typeof id !== "string" || !isExecutionId(id)) {
    throw new Error(
      "Executed MCP tool result omitted valid execution metadata.",
    );
  }
  return id;
}

export interface McpDemoEnvironment {
  client: InProcessMcpClient;
  engine: ExecutionEngine;
  executorApp: ReturnType<typeof createExecutorApp>;
  providers: {
    gmail: ReturnType<typeof createGmailMock>;
    github: ReturnType<typeof createGitHubMock>;
    slack: ReturnType<typeof createSlackMock>;
  };
}

export async function createMcpDemoEnvironment(
  discoveryMode: ToolDiscoveryMode,
): Promise<McpDemoEnvironment> {
  const gmail = createGmailMock();
  const github = createGitHubMock();
  const slack = createSlackMock();
  await github.seed(githubFixtures.default);
  await slack.seed(slackFixtures.default);
  const mockhouse = createMockApp({ providers: [gmail, github, slack] });
  let executionSequence = 0;
  const engine = new ExecutionEngine({
    credentialProvider: new MockCredentialProvider([
      {
        match: {
          projectId: MCP_DEMO_PROJECT_ID,
          userId: MCP_DEMO_USER_ID,
          toolkitSlug: "gmail",
        },
        credential: {
          type: "oauth2",
          accessToken: "fixture:valid",
          scopes: [GMAIL_SCOPE],
        },
      },
      {
        match: {
          projectId: MCP_DEMO_PROJECT_ID,
          userId: MCP_DEMO_USER_ID,
          toolkitSlug: "github",
        },
        credential: { type: "oauth2", accessToken: "fixture:valid" },
      },
      {
        match: {
          projectId: MCP_DEMO_PROJECT_ID,
          userId: MCP_DEMO_USER_ID,
          toolkitSlug: "slack",
        },
        credential: {
          type: "oauth2",
          accessToken: "fixture:valid",
          scopes: ["chat:write"],
        },
      },
    ]),
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== MOCK_ORIGIN) {
        throw new Error(`Unexpected provider origin: ${request.url}`);
      }
      return mockhouse.request(request);
    }) as typeof fetch,
    env: {
      EYEBALL_GMAIL_BASE_URL: `${MOCK_ORIGIN}/gmail`,
      EYEBALL_GITHUB_BASE_URL: `${MOCK_ORIGIN}/github`,
      EYEBALL_SLACK_BASE_URL: `${MOCK_ORIGIN}/slack`,
    },
    executionIdFactory: () => {
      executionSequence += 1;
      return createExecutionId(`agent_loop_${executionSequence}`);
    },
  });
  const executorApp = createExecutorApp({
    engine,
    apiKeys: { [MCP_DEMO_API_KEY]: MCP_DEMO_PROJECT_ID },
    requestIdFactory: () => "req_agent_loop",
  });
  const gateway = createMcpGatewayApp({
    executorBaseUrl: EXECUTOR_ORIGIN,
    fetchImpl: (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== EXECUTOR_ORIGIN) {
        throw new Error(`Unexpected executor origin: ${request.url}`);
      }
      return executorApp.request(request);
    }) as typeof fetch,
    apiKey: MCP_DEMO_API_KEY,
    userId: MCP_DEMO_USER_ID,
    discoveryMode,
    sessionIdFactory: () => "mcp_agent_loop",
  });
  const client = new InProcessMcpClient(gateway);
  await client.initialize();
  return {
    client,
    engine,
    executorApp,
    providers: { gmail, github, slack },
  };
}

export interface ScriptedMcpDemoResult {
  calls: readonly string[];
  childExecutions: readonly {
    executionId: ExecutionId;
    tool: QualifiedToolName;
    userId: string;
  }[];
  issueId: string;
  providerEffects: {
    emailSent: boolean;
    issueCreated: boolean;
    announcementSent: boolean;
  };
}

/** Runs a deterministic three-tool MCP episode without network or loopback sockets. */
export async function runScriptedMcpDemo(): Promise<ScriptedMcpDemoResult> {
  const environment = await createMcpDemoEnvironment("search");
  const { client, executorApp, providers } = environment;

  if (!(await client.search("send an email")).includes("gmail.send_email")) {
    throw new Error("MCP search did not discover gmail.send_email.");
  }
  const email = await client.call("gmail.send_email", {
    to: ["owner@acme.example"],
    subject: "Agent-loop kickoff",
    body: "The scripted Eyeball agent started the workflow.",
  });

  if (
    !(await client.search("create an issue")).includes("github.create_issue")
  ) {
    throw new Error("MCP search did not discover github.create_issue.");
  }
  const issue = await client.call("github.create_issue", {
    projectId: "acme-example/eyeball-fixture",
    title: "Follow up on the agent-loop demo",
    body: "Created by the deterministic MCP episode.",
    labels: ["enhancement"],
  });
  const issueIdValue = (
    issue.structuredContent?.issue as { issueId?: unknown } | undefined
  )?.issueId;
  if (
    (typeof issueIdValue !== "string" && typeof issueIdValue !== "number") ||
    String(issueIdValue).length === 0
  ) {
    throw new Error("GitHub result omitted a valid issue ID.");
  }
  const issueId = String(issueIdValue);
  const announcementText = `Created GitHub issue #${issueId} after sending the kickoff email.`;
  const announcement = await client.call("slack.send_message", {
    conversationId: "C_GENERAL",
    text: announcementText,
  });
  const childExecutionIds = [
    executionId(email),
    executionId(issue),
    executionId(announcement),
  ];

  const listedResponse = await executorApp.request(
    `/v1/executions?userId=${encodeURIComponent(MCP_DEMO_USER_ID)}&limit=100`,
    { headers: { Authorization: `Bearer ${MCP_DEMO_API_KEY}` } },
  );
  if (!listedResponse.ok) {
    throw new Error(
      `Executor list request failed with HTTP ${listedResponse.status}.`,
    );
  }
  const listed = (await listedResponse.json()) as {
    executions: Array<{
      executionId: string;
      tool: QualifiedToolName;
      userId: string;
    }>;
  };
  const byCallOrder = childExecutionIds.map((id) => {
    const execution = listed.executions.find(
      ({ executionId: candidate }) => candidate === id,
    );
    if (execution === undefined) {
      throw new Error(`Executor omitted child execution ${id}.`);
    }
    return {
      executionId: id,
      tool: execution.tool,
      userId: execution.userId,
    };
  });

  return {
    calls: [...client.calledNames],
    childExecutions: byCallOrder,
    issueId,
    providerEffects: {
      emailSent: storeRecords<GmailMessage>(providers.gmail, "messages").some(
        (message) =>
          Buffer.from(message.raw, "base64url")
            .toString("utf8")
            .includes("Subject: Agent-loop kickoff"),
      ),
      issueCreated: storeRecords<GitHubIssue>(providers.github, "issues").some(
        ({ title }) => title === "Follow up on the agent-loop demo",
      ),
      announcementSent: storeRecords<SlackMessage>(
        providers.slack,
        "messages",
      ).some(({ text }) => text === announcementText),
    },
  };
}

async function runCli(): Promise<void> {
  const result = await runScriptedMcpDemo();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  runCli().catch((error: unknown) => {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
