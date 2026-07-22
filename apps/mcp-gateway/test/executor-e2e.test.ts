import {
  createConnectionId,
  createExecutionId,
  MockCredentialProvider,
  type ToolkitAdapter,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
} from "../../executor/src/index.js";
import { createMcpGatewayApp, MCP_PROTOCOL_VERSION } from "../src/index.js";

const API_KEY = "ey_test_mcp_e2e";
const PROJECT_ID = "proj_mcp_e2e";
const USER_ID = "user_mcp_e2e";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

describe("MCP gateway to executor", () => {
  it("advertises stock task cancellation and forwards it to the executor cancel route", async () => {
    const executionId = createExecutionId("mcp_stock_cancel");
    const requests: Request[] = [];
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      const path = new URL(request.url).pathname;
      if (path === "/v1/execute") {
        return Response.json(
          {
            executionId,
            tool: "twilio.start_call",
            toolVersion: "1.0.0",
            catalogVersion: "1.1",
            status: "pending",
          },
          { status: 202 },
        );
      }
      if (path === `/v1/executions/${executionId}/cancel`) {
        return Response.json({
          executionId,
          tool: "twilio.start_call",
          toolVersion: "1.0.0",
          catalogVersion: "1.1",
          userId: USER_ID,
          createdAt: "2026-07-21T12:00:00.000Z",
          completedAt: "2026-07-21T12:00:00.010Z",
          latencyMs: 10,
          status: "cancelled",
          error: {
            code: "execution_cancelled",
            message: "Execution was cancelled before provider dispatch.",
            retryable: false,
          },
          cancellation: { dispatchMayHaveBegun: false },
        });
      }
      throw new Error(
        `Unexpected stock executor request: ${request.method} ${path}`,
      );
    }) as typeof fetch;
    const gateway = createMcpGatewayApp({
      executorBaseUrl: "https://executor.mcp.test",
      fetchImpl,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => "mcp_stock_cancel_session",
      taskPollMs: 60_000,
    });
    const initialized = await gateway.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize-cancel",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tasks: {} },
          clientInfo: { name: "cancel-e2e", version: "1.0.0" },
        },
      }),
    });
    await expect(initialized.json()).resolves.toMatchObject({
      result: { capabilities: { tasks: { cancel: {} } } },
    });
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": "mcp_stock_cancel_session",
    };
    await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "call-cancel",
        method: "tools/call",
        params: {
          name: "twilio.start_call",
          arguments: {
            to: "+966500000000",
            from: "+12025550173",
            voiceAgentId: "vag_mcp_cancel",
          },
          task: { ttl: 120_000 },
        },
      }),
    });
    const cancelled = await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "cancel-task",
        method: "tasks/cancel",
        params: { taskId: executionId },
      }),
    });
    const cancelledBody = (await cancelled.json()) as {
      result: Record<string, unknown>;
    };
    expect(cancelledBody).toMatchObject({
      result: { taskId: executionId, status: "cancelled" },
    });
    expect(cancelledBody.result).not.toHaveProperty("_meta");
    expect(
      requests.map((request) => [
        request.method,
        new URL(request.url).pathname,
      ]),
    ).toEqual([
      ["POST", "/v1/execute"],
      ["POST", `/v1/executions/${executionId}/cancel`],
    ]);
    await expect(requests[1]?.text()).resolves.toBe("");
  });

  it("replays one mutating MCP call as one executor allocation", async () => {
    const execute = vi.fn(async ({ canonicalInput }) => ({
      messageId: "msg_mcp_e2e",
      acceptedRecipients: canonicalInput.to,
    }));
    const adapter: ToolkitAdapter = {
      toolkitSlug: "gmail",
      execute,
    };
    const engine = new ExecutionEngine({
      adapters: new AdapterRegistry([adapter]),
      credentialProvider: new MockCredentialProvider([
        {
          match: {
            projectId: PROJECT_ID,
            userId: USER_ID,
            toolkitSlug: "gmail",
          },
          credential: {
            type: "oauth2",
            accessToken: "fixture:mcp-e2e",
            scopes: [GMAIL_SCOPE],
          },
        },
      ]),
      executionIdFactory: () => createExecutionId("mcp_e2e"),
    });
    const executorApp = createExecutorApp({
      engine,
      apiKeys: { [API_KEY]: PROJECT_ID },
      requestIdFactory: () => "req_mcp_e2e",
    });
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => executorApp.request(new Request(input, init))) as typeof fetch;
    const gateway = createMcpGatewayApp({
      executorBaseUrl: "https://executor.mcp.test",
      fetchImpl,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => "mcp_e2e_session",
    });
    const call = {
      jsonrpc: "2.0",
      id: "tool-call-19",
      method: "tools/call",
      params: {
        name: "gmail.send_email",
        arguments: {
          to: ["recipient@example.com"],
          subject: "MCP delivery",
          body: "One logical call should allocate once.",
        },
      },
    };
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": "mcp_e2e_session",
    };

    await gateway.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "executor-e2e", version: "1.0.0" },
        },
      }),
    });

    const first = await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(call),
    });
    const replay = await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(call),
    });
    const firstBody = (await first.json()) as {
      result: {
        structuredContent: unknown;
        _meta: { "dev.eyeball/execution": { executionId: string } };
      };
    };
    const replayBody = (await replay.json()) as typeof firstBody;

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(firstBody.result.structuredContent).toEqual({
      messageId: "msg_mcp_e2e",
      acceptedRecipients: ["recipient@example.com"],
    });
    expect(replayBody.result).toEqual(firstBody.result);
    expect(firstBody.result._meta["dev.eyeball/execution"].executionId).toBe(
      "exe_mcp_e2e",
    );
    expect(execute).toHaveBeenCalledTimes(1);

    const stored = await engine.getExecution(PROJECT_ID, "exe_mcp_e2e");
    expect(stored).toMatchObject({
      status: "succeeded",
      tool: "gmail.send_email",
      userId: USER_ID,
      output: {
        messageId: "msg_mcp_e2e",
        acceptedRecipients: ["recipient@example.com"],
      },
    });
  });

  it("cannot use a connection belonging to another user or project", async () => {
    const USER_B = "user_mcp_other";
    const PROJECT_B = "proj_mcp_other";
    const ownConnection = createConnectionId("mcp_own");
    const otherUserConnection = createConnectionId("mcp_other_user");
    const otherProjectConnection = createConnectionId("mcp_other_project");
    const execute = vi.fn(async () => ({ emails: [] }));
    let executionIndex = 0;
    const engine = new ExecutionEngine({
      adapters: new AdapterRegistry([
        { toolkitSlug: "gmail", execute } satisfies ToolkitAdapter,
      ]),
      credentialProvider: new MockCredentialProvider([
        {
          match: {
            projectId: PROJECT_ID,
            userId: USER_ID,
            toolkitSlug: "gmail",
            connectionId: ownConnection,
          },
          credential: {
            type: "oauth2",
            accessToken: "fixture:own",
            scopes: [GMAIL_SCOPE],
          },
        },
        {
          match: {
            projectId: PROJECT_ID,
            userId: USER_B,
            toolkitSlug: "gmail",
            connectionId: otherUserConnection,
          },
          credential: {
            type: "oauth2",
            accessToken: "fixture:other-user",
            scopes: [GMAIL_SCOPE],
          },
        },
        {
          match: {
            projectId: PROJECT_B,
            userId: USER_ID,
            toolkitSlug: "gmail",
            connectionId: otherProjectConnection,
          },
          credential: {
            type: "oauth2",
            accessToken: "fixture:other-project",
            scopes: [GMAIL_SCOPE],
          },
        },
      ]),
      executionIdFactory: () => {
        executionIndex += 1;
        return createExecutionId(`mcp_scope_${executionIndex}`);
      },
    });
    const executorApp = createExecutorApp({
      engine,
      apiKeys: {
        [API_KEY]: { projectId: PROJECT_ID, userId: USER_ID },
      },
      requestIdFactory: () => "req_mcp_scope",
    });
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => executorApp.request(new Request(input, init))) as typeof fetch;
    const gateway = createMcpGatewayApp({
      executorBaseUrl: "https://executor.mcp.test",
      fetchImpl,
      apiKeys: {
        [API_KEY]: { projectId: PROJECT_ID, userId: USER_ID },
      },
    });
    const invoke = async (connectionId: string, id: string) =>
      gateway.request("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "gmail.list_emails",
            arguments: {},
            _meta: { "dev.eyeball/connectionId": connectionId },
          },
        }),
      });

    const own = await invoke(ownConnection, "own");
    const crossUser = await invoke(otherUserConnection, "cross-user");
    const crossProject = await invoke(otherProjectConnection, "cross-project");

    await expect(own.json()).resolves.toMatchObject({
      result: { structuredContent: { emails: [] } },
    });
    for (const response of [crossUser, crossProject]) {
      await expect(response.json()).resolves.toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining("auth_missing") }],
        },
      });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
