import {
  createExecutionId,
  type ExecutionRecord,
  type ExecutionResult,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpGatewayApp,
  InMemorySessionStore,
  MCP_PROTOCOL_VERSION,
  type McpClock,
  type McpExecutor,
} from "../src/index.js";

const API_KEY = "ey_test_mcp_stream";
const USER_ID = "user_mcp_stream";
const SESSION_ID = "mcp_stream_session";
const TASK_ID = createExecutionId("mcp_stream_task");

class ManualClock implements McpClock {
  value = Date.parse("2026-07-19T00:00:00.000Z");
  readonly handles = new Map<object, { callback: () => void; runAt: number }>();

  now(): number {
    return this.value;
  }

  setTimeout(callback: () => void, delayMs: number): object {
    const handle = {};
    this.handles.set(handle, { callback, runAt: this.value + delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null) {
      this.handles.delete(handle);
    }
  }

  advance(milliseconds: number): void {
    this.value += milliseconds;
    while (true) {
      const due = [...this.handles].find(
        ([, scheduled]) => scheduled.runAt <= this.value,
      );
      if (due === undefined) return;
      this.handles.delete(due[0]);
      due[1].callback();
    }
  }
}

function pending(): ExecutionResult {
  return {
    executionId: TASK_ID,
    tool: "twilio.start_call",
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    status: "pending",
  };
}

function succeeded(): ExecutionRecord {
  return {
    ...pending(),
    status: "succeeded",
    userId: USER_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    completedAt: "2026-07-19T00:00:02.000Z",
    output: { callId: "call_stream", status: "completed" },
    latencyMs: 2_000,
  };
}

function rpc(method: string, params?: unknown, id: string | number = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
}

function post(
  app: ReturnType<typeof createMcpGatewayApp>,
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

function initialize(
  app: ReturnType<typeof createMcpGatewayApp>,
  tasks = false,
): Promise<Response> {
  return post(
    app,
    rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: tasks ? { experimental: { tasks: {} } } : {},
      clientInfo: { name: "stream-test", version: "1.0.0" },
    }),
  );
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(expected)) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out waiting for ${expected}`)),
          1_000,
        ),
      ),
    ]);
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("MCP Streamable HTTP SSE", () => {
  it("frames POST request responses as resumable SSE when the client accepts it", async () => {
    const app = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKey: API_KEY,
      eventIdFactory: () => "event_1",
    });
    const response = await post(app, rpc("ping"), {
      Accept: "application/json, text/event-stream",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body).toContain("id: stateless:event_1\ndata:\n\n");
    expect(body).toContain(
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n\n`,
    );
  });

  it("delivers progress and task-status notifications on a session GET stream", async () => {
    let record: ExecutionRecord = {
      ...pending(),
      status: "running",
      userId: USER_ID,
      createdAt: "2026-07-19T00:00:00.000Z",
      startedAt: "2026-07-19T00:00:01.000Z",
    };
    const execution: McpExecutor = {
      execute: vi.fn(),
      start: vi.fn(async () => pending()),
      get: vi.fn(async () => record),
    };
    let eventIndex = 0;
    const clock = new ManualClock();
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
      eventIdFactory: () => `event_${++eventIndex}`,
      taskPollMs: 60_000,
      clock,
    });
    await initialize(app, true);

    const stream = await app.request("/mcp", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": SESSION_ID,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    expect(await readUntil(reader, "data:\n\n")).toContain("id:");

    const created = await post(
      app,
      rpc("tools/call", {
        name: "twilio.start_call",
        arguments: {},
        task: {},
        _meta: { progressToken: "progress-stream" },
      }),
      { "Mcp-Session-Id": SESSION_ID },
    );
    expect(created.status).toBe(200);
    const progress = await readUntil(reader, "notifications/progress");
    expect(progress).toContain('"progressToken":"progress-stream"');
    expect(progress).toContain(
      `"io.modelcontextprotocol/related-task":{"taskId":"${TASK_ID}"}`,
    );

    record = succeeded();
    await post(app, rpc("tasks/get", { taskId: TASK_ID }), {
      "Mcp-Session-Id": SESSION_ID,
    });
    const terminal = await readUntil(reader, "notifications/tasks/status");
    expect(terminal).toContain('"status":"completed"');

    const deleted = await app.request("/mcp", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Mcp-Session-Id": SESSION_ID,
      },
    });
    expect(deleted.status).toBe(204);
    await reader.cancel();
    expect(clock.handles.size).toBe(0);
  });

  it("rejects unknown and expired sessions without disclosing auth bindings", async () => {
    const clock = new ManualClock();
    const app = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKey: API_KEY,
      sessionIdFactory: () => SESSION_ID,
      sessionTtlMs: 1_000,
      clock,
    });

    const missing = await app.request("/mcp", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": "mcp_unknown",
      },
    });
    expect(missing.status).toBe(404);

    await initialize(app);
    const stream = await app.request("/mcp", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "text/event-stream",
        "Mcp-Session-Id": SESSION_ID,
      },
    });
    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    await reader.read();
    clock.advance(1_001);
    await expect(reader.read()).resolves.toMatchObject({ done: true });
    const expired = await post(app, rpc("ping"), {
      "Mcp-Session-Id": SESSION_ID,
    });
    expect(expired.status).toBe(404);
  });

  it("persists only a one-way auth binding through the injectable session seam", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKey: API_KEY,
      sessionIdFactory: () => SESSION_ID,
      sessionStore,
    });

    await initialize(app);
    const stored = await sessionStore.get(SESSION_ID);
    expect(stored).toMatchObject({
      sessionId: SESSION_ID,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tasksEnabled: false,
    });
    expect(stored?.authBinding).not.toBe(API_KEY);
    expect(JSON.stringify(stored)).not.toContain(API_KEY);

    const deleted = await app.request("/mcp", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Mcp-Session-Id": SESSION_ID,
      },
    });
    expect(deleted.status).toBe(204);
    await expect(sessionStore.get(SESSION_ID)).resolves.toBeUndefined();
  });

  it("does not let another inbound credential attach to a session", async () => {
    const app = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKeys: {
        [API_KEY]: "project_stream",
        ey_test_mcp_stream_other: "project_stream",
      },
      executorApiKey: "ey_executor_stream",
      sessionIdFactory: () => SESSION_ID,
    });
    await initialize(app);

    const crossCredential = await app.request("/mcp", {
      method: "GET",
      headers: {
        Authorization: "Bearer ey_test_mcp_stream_other",
        Accept: "text/event-stream",
        "Mcp-Session-Id": SESSION_ID,
      },
    });
    expect(crossCredential.status).toBe(404);
  });

  it("validates browser origins before accepting authenticated MCP traffic", async () => {
    const app = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKey: API_KEY,
      allowedOrigins: ["https://trusted.example"],
    });
    const rejected = await post(app, rpc("ping"), {
      Origin: "https://untrusted.example",
    });
    const accepted = await post(app, rpc("ping"), {
      Origin: "https://trusted.example",
    });
    const strictDefault = createMcpGatewayApp({
      executor: { execute: vi.fn() } as unknown as McpExecutor,
      apiKey: API_KEY,
    });
    const rejectedWithoutAllowlist = await post(strictDefault, rpc("ping"), {
      Origin: "http://localhost",
    });

    expect(rejected.status).toBe(403);
    expect(accepted.status).toBe(200);
    expect(rejectedWithoutAllowlist.status).toBe(403);
  });
});
