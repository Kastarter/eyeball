import {
  createExecutionId,
  type ExecutionRecord,
  EyeballError,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpGatewayApp,
  MCP_PROTOCOL_VERSION,
  type McpExecuteRequest,
  type McpExecutor,
  type TerminalExecution,
} from "../src/index.js";

const API_KEY = "ey_test_mcp";
const USER_ID = "user_mcp";

function succeeded(
  output: Readonly<Record<string, unknown>> = { emails: [] },
): TerminalExecution {
  return {
    executionId: createExecutionId("mcp_success"),
    tool: "gmail.list_emails",
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    status: "succeeded",
    output: output as never,
    latencyMs: 6,
  };
}

function executor(
  implementation: (
    request: McpExecuteRequest,
  ) => Promise<TerminalExecution> = async () => succeeded(),
): McpExecutor & { execute: ReturnType<typeof vi.fn> } {
  return { execute: vi.fn(implementation) };
}

async function request(
  app: Hono,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function rpc(method: string, params?: unknown, id: string | number = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

describe("MCP Streamable HTTP gateway", () => {
  it("negotiates the pinned protocol without advertising unimplemented Tasks", async () => {
    const app = createMcpGatewayApp({
      executor: executor(),
      apiKey: API_KEY,
      sessionIdFactory: () => "mcp_session_test",
    });
    const response = await request(
      app,
      rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "scripted-test", version: "1.0.0" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBe("mcp_session_test");
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "eyeball-mcp-gateway", version: "0.1.0" },
        instructions:
          "Use eyeball.search_tools to find canonical provider tools. In search discovery mode, invoke a returned tool through eyeball.execute_tool. Tool failures are returned as normalized MCP tool results. Async-by-nature tools run to completion before the call returns.",
      },
    });
  });

  it("lists exact canonical schemas and annotations including async-by-nature tools", async () => {
    const app = createMcpGatewayApp({ executor: executor(), apiKey: API_KEY });
    const response = await request(app, rpc("tools/list"));
    const body = (await response.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const search = body.result.tools.find(
      ({ name }) => name === "eyeball.search_tools",
    );
    const gmail = body.result.tools.find(
      ({ name }) => name === "gmail.list_emails",
    );

    expect(search).toMatchObject({
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    });
    expect(gmail).toMatchObject({
      name: "gmail.list_emails",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
      _meta: {
        "dev.eyeball/tool": {
          toolkit: "gmail",
          capability: "email",
          version: "1.0.0",
        },
      },
    });
    const startCall = body.result.tools.find(
      ({ name }) => name === "twilio.start_call",
    );
    expect(startCall).toMatchObject({
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    });
    expect(startCall).not.toHaveProperty("execution");
    expect(
      body.result.tools.some(({ name }) => name === "gmail__list_emails"),
    ).toBe(false);
  });

  it("supports an opt-in search-only listing for context-constrained hosts", async () => {
    const app = createMcpGatewayApp({
      executor: executor(),
      apiKey: API_KEY,
      discoveryMode: "search",
    });
    const response = await request(app, rpc("tools/list"));

    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: [
          { name: "eyeball.search_tools" },
          { name: "eyeball.execute_tool" },
        ],
      },
    });
  });

  it("searches the callable catalog without allocating an execution", async () => {
    const execution = executor();
    const app = createMcpGatewayApp({ executor: execution, apiKey: API_KEY });
    const response = await request(
      app,
      rpc(
        "tools/call",
        {
          name: "eyeball.search_tools",
          arguments: { query: "gmail send email", limit: 2 },
        },
        "search-1",
      ),
    );
    const body = (await response.json()) as {
      result: {
        structuredContent: { tools: Array<{ name: string }> };
        content: Array<{ text: string }>;
      };
    };

    expect(body.result.structuredContent.tools[0]?.name).toBe(
      "gmail.send_email",
    );
    expect(JSON.parse(body.result.content[0]?.text ?? "null")).toEqual(
      body.result.structuredContent,
    );
    expect(execution.execute).not.toHaveBeenCalled();
  });

  it("executes a discovered canonical tool through the search-mode dispatcher", async () => {
    const execution = executor();
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      discoveryMode: "search",
    });

    const response = await request(
      app,
      rpc("tools/call", {
        name: "eyeball.execute_tool",
        arguments: {
          name: "gmail.list_emails",
          input: { query: "invoice" },
        },
      }),
    );

    expect(execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "gmail.list_emails",
        input: { query: "invoice" },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: { structuredContent: { emails: [] } },
    });
  });

  it("dispatches a terminal call with stable idempotency and execution metadata", async () => {
    const execution = executor();
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      sessionIdFactory: () => "mcp_session_42",
    });
    await request(
      app,
      rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "scripted-test", version: "1.0.0" },
      }),
    );
    const response = await request(
      app,
      rpc(
        "tools/call",
        { name: "gmail.list_emails", arguments: { query: "invoice" } },
        "call-42",
      ),
      {
        "X-Eyeball-User-Id": USER_ID,
        "Mcp-Session-Id": "mcp_session_42",
      },
    );

    expect(execution.execute).toHaveBeenCalledWith({
      apiKey: API_KEY,
      userId: USER_ID,
      tool: "gmail.list_emails",
      input: { query: "invoice" },
      idempotencyKey: "mcp:mcp_session_42:call-42",
    });
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: "call-42",
      result: {
        content: [{ type: "text", text: JSON.stringify({ emails: [] }) }],
        structuredContent: { emails: [] },
        _meta: {
          "dev.eyeball/execution": {
            executionId: "exe_mcp_success",
            tool: "gmail.list_emails",
            toolVersion: "1.0.0",
            catalogVersion: "1.1",
            status: "succeeded",
            latencyMs: 6,
          },
        },
      },
    });
  });

  it("lets callers explicitly correlate retries and select a connection", async () => {
    const execution = executor();
    const app = createMcpGatewayApp({ executor: execution, apiKey: API_KEY });
    await request(
      app,
      rpc("tools/call", {
        name: "gmail.list_emails",
        arguments: {},
        _meta: {
          "dev.eyeball/userId": USER_ID,
          "dev.eyeball/connectionId": "conn_mcp_primary",
          "dev.eyeball/idempotencyKey": "workflow-step-7",
        },
      }),
    );

    expect(execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        connectionId: "conn_mcp_primary",
        idempotencyKey: "workflow-step-7",
      }),
    );
  });

  it("returns terminal failures as tool errors with execution metadata", async () => {
    const execution = executor(async () => ({
      executionId: createExecutionId("mcp_failed"),
      tool: "gmail.list_emails",
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      status: "failed",
      error: {
        code: TOOL_ERROR_CODES.RATE_LIMITED,
        message: "Gmail quota exceeded.",
        retryable: true,
        retryAfter: 4,
      },
      latencyMs: 8,
    }));
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
    });
    const response = await request(
      app,
      rpc("tools/call", { name: "gmail.list_emails", arguments: {} }),
    );

    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "rate_limited",
                message: "Gmail quota exceeded.",
                retryable: true,
                retryAfter: 4,
              },
            }),
          },
        ],
        _meta: {
          "dev.eyeball/execution": {
            executionId: "exe_mcp_failed",
            status: "failed",
            latencyMs: 8,
          },
        },
      },
    });
  });

  it("keeps pre-allocation and unexpected failures out of success schemas", async () => {
    const expected = executor(async () => {
      throw new EyeballError({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
        message: "Canonical input is invalid.",
      });
    });
    const redacted = executor(async () => {
      throw new Error("internal detail fixture:SECRET_TOKEN");
    });
    const expectedApp = createMcpGatewayApp({
      executor: expected,
      apiKey: API_KEY,
      userId: USER_ID,
    });
    const redactedApp = createMcpGatewayApp({
      executor: redacted,
      apiKey: API_KEY,
      userId: USER_ID,
    });

    const expectedBody = await (
      await request(
        expectedApp,
        rpc("tools/call", { name: "gmail.list_emails", arguments: {} }),
      )
    ).json();
    const redactedBody = await (
      await request(
        redactedApp,
        rpc("tools/call", { name: "gmail.list_emails", arguments: {} }),
      )
    ).json();

    expect(expectedBody).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: JSON.stringify({
              error: {
                code: "invalid_input",
                message: "Canonical input is invalid.",
                retryable: false,
              },
            }),
          },
        ],
      },
    });
    expect(
      (expectedBody as { result: Record<string, unknown> }).result,
    ).not.toHaveProperty("structuredContent");
    expect(
      (expectedBody as { result: Record<string, unknown> }).result,
    ).not.toHaveProperty("_meta");
    expect(JSON.stringify(redactedBody)).toContain(
      "Tool execution failed unexpectedly.",
    );
    expect(JSON.stringify(redactedBody)).not.toContain("SECRET_TOKEN");
  });

  it("bridges direct async calls to completion when Tasks are not negotiated", async () => {
    const execution = executor(async (request) => ({
      executionId: createExecutionId("mcp_async_bridge"),
      tool: request.tool,
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      status: "succeeded",
      output: { callId: "call_mcp_async", status: "queued" } as never,
      latencyMs: 12,
    }));
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
    });
    const response = await request(
      app,
      rpc("tools/call", {
        name: "twilio.start_call",
        arguments: {
          to: "+966500000000",
          from: "+12025550173",
          voiceAgentId: "vag_mcp",
        },
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: { callId: "call_mcp_async", status: "queued" },
      },
    });
    expect(execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "twilio.start_call", mode: "async" }),
    );
  });

  it("implements transport errors, notifications, and bearer authentication", async () => {
    const app = createMcpGatewayApp({ executor: executor() });
    const unauthorized = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc("ping")),
    });
    const malformed = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{not-json",
    });
    const notification = await request(app, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const get = await app.request("/mcp", { method: "GET" });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: -32700, message: "Parse error" },
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("POST, GET, DELETE");
  });

  it("does not let a configured executor key authenticate inbound clients", async () => {
    const app = createMcpGatewayApp({ executor: executor(), apiKey: API_KEY });
    const missing = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpc("ping")),
    });
    const invalid = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(rpc("ping")),
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it("enforces a pinned MCP user across headers and tools/call metadata", async () => {
    const execution = executor();
    const app = createMcpGatewayApp({
      executor: execution,
      apiKeys: {
        [API_KEY]: { projectId: "project_mcp", userId: USER_ID },
      },
    });
    const accepted = await request(
      app,
      rpc("tools/call", {
        name: "gmail.list_emails",
        arguments: {},
        _meta: { "dev.eyeball/userId": USER_ID },
      }),
      { "X-Eyeball-User-Id": USER_ID },
    );
    const wrongHeader = await request(app, rpc("ping"), {
      "X-Eyeball-User-Id": "user_other",
    });
    const wrongMeta = await request(
      app,
      rpc("tools/call", {
        name: "gmail.list_emails",
        arguments: {},
        _meta: { "dev.eyeball/userId": "user_other" },
      }),
    );

    expect(accepted.status).toBe(200);
    expect(execution.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
    expect(wrongHeader.status).toBe(403);
    await expect(wrongMeta.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("auth_insufficient_scope") }],
      },
    });
    expect(execution.execute).toHaveBeenCalledTimes(1);
  });
});

describe("HTTP executor bridge", () => {
  it("forwards MCP identity, canonical input, and stable call id to the executor", async () => {
    const executorRequests: Request[] = [];
    const executorApp = new Hono();
    executorApp.post("/v1/execute", async (context) => {
      executorRequests.push(context.req.raw.clone());
      return context.json(succeeded({ emails: [] }));
    });
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => executorApp.request(new Request(input, init))) as typeof fetch;
    const app = createMcpGatewayApp({
      executorBaseUrl: "https://executor.test",
      fetchImpl,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => "mcp_http",
    });

    await request(
      app,
      rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "scripted-test", version: "1.0.0" },
      }),
    );

    const response = await request(
      app,
      rpc(
        "tools/call",
        { name: "gmail.list_emails", arguments: { query: "invoice" } },
        "http-7",
      ),
      { "Mcp-Session-Id": "mcp_http" },
    );

    expect(response.status).toBe(200);
    expect(executorRequests).toHaveLength(1);
    expect(executorRequests[0]?.headers.get("Authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(executorRequests[0]?.headers.get("Idempotency-Key")).toBe(
      "mcp:mcp_http:http-7",
    );
    await expect(executorRequests[0]?.json()).resolves.toEqual({
      tool: "gmail.list_emails",
      userId: USER_ID,
      input: { query: "invoice" },
      mode: "sync",
    });
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: { emails: [] },
        _meta: {
          "dev.eyeball/execution": { executionId: "exe_mcp_success" },
        },
      },
    });
  });

  it("allocates and resolves negotiated tasks through the SDK bridge", async () => {
    const taskId = createExecutionId("mcp_http_task");
    const executorRequests: Request[] = [];
    let statusReads = 0;
    const executorApp = new Hono();
    executorApp.post("/v1/execute", async (context) => {
      executorRequests.push(context.req.raw.clone());
      return context.json(
        {
          executionId: taskId,
          tool: "twilio.start_call",
          toolVersion: "1.0.0",
          catalogVersion: "1.1",
          status: "pending",
        },
        202,
      );
    });
    executorApp.get("/v1/executions/:id", (context) => {
      statusReads += 1;
      return context.json({
        executionId: taskId,
        tool: "twilio.start_call",
        toolVersion: "1.0.0",
        catalogVersion: "1.1",
        status: "succeeded",
        userId: USER_ID,
        createdAt: "2026-07-19T00:00:00.000Z",
        completedAt: "2026-07-19T00:00:02.000Z",
        output: { callId: "call_http_task", status: "completed" },
        latencyMs: 2_000,
      } satisfies ExecutionRecord);
    });
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => executorApp.request(new Request(input, init))) as typeof fetch;
    const app = createMcpGatewayApp({
      executorBaseUrl: "https://executor.test",
      fetchImpl,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => "mcp_http_task",
      taskPollMs: 60_000,
    });
    await request(
      app,
      rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tasks: {} },
        clientInfo: { name: "scripted-test", version: "1.0.0" },
      }),
    );

    const created = await request(
      app,
      rpc(
        "tools/call",
        {
          name: "twilio.start_call",
          arguments: {
            to: "+966500000000",
            from: "+12025550173",
            voiceAgentId: "vag_http_task",
          },
          task: {},
        },
        "http-task-call",
      ),
      { "Mcp-Session-Id": "mcp_http_task" },
    );
    await expect(created.json()).resolves.toMatchObject({
      result: { task: { taskId, status: "working" } },
    });
    await expect(executorRequests[0]?.json()).resolves.toMatchObject({
      tool: "twilio.start_call",
      userId: USER_ID,
      mode: "async",
    });

    const result = await request(
      app,
      rpc("tasks/result", { taskId }, "http-task-result"),
      { "Mcp-Session-Id": "mcp_http_task" },
    );
    await expect(result.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          callId: "call_http_task",
          status: "completed",
        },
        _meta: {
          "dev.eyeball/execution": { executionId: taskId },
          "io.modelcontextprotocol/related-task": { taskId },
        },
      },
    });
    expect(statusReads).toBe(2);
  });
});
