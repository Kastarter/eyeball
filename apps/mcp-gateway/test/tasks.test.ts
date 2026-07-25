import {
  type CancelledExecutionRecord,
  createExecutionId,
  type ExecutionRecord,
  type ExecutionResult,
  TOOL_ERROR_CODES,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpGatewayApp,
  createPgliteMcpGatewayStoreBundle,
  InMemorySessionStore,
  MCP_PROTOCOL_VERSION,
  type McpClock,
  type McpExecuteRequest,
  type McpExecutor,
  type SessionStore,
  type TerminalExecution,
} from "../src/index.js";

const API_KEY = "ey_test_mcp_tasks";
const USER_ID = "user_mcp_tasks";
const SESSION_ID = "mcp_tasks_session";
const TASK_ID = createExecutionId("mcp_task");

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

interface TestSessionStore {
  store: SessionStore;
  close(): Promise<void>;
}

const sessionStores = [
  {
    name: "memory",
    create: async (): Promise<TestSessionStore> => ({
      store: new InMemorySessionStore(),
      close: async () => undefined,
    }),
  },
  {
    name: "PGlite",
    create: async (): Promise<TestSessionStore> => {
      const bundle = await createPgliteMcpGatewayStoreBundle();
      return { store: bundle.sessionStore, close: () => bundle.close() };
    },
  },
] as const;

function pending(): ExecutionResult {
  return {
    executionId: TASK_ID,
    tool: "twilio.start_call",
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    status: "pending",
  };
}

function running(): ExecutionRecord {
  return {
    ...pending(),
    status: "running",
    userId: USER_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    startedAt: "2026-07-19T00:00:01.000Z",
  };
}

function succeeded(): ExecutionRecord {
  return {
    ...pending(),
    status: "succeeded",
    userId: USER_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    startedAt: "2026-07-19T00:00:01.000Z",
    completedAt: "2026-07-19T00:00:05.000Z",
    output: {
      callId: "call_mcp_task",
      status: "completed",
      durationSeconds: 4,
    },
    latencyMs: 4_000,
  };
}

function failed(): ExecutionRecord {
  return {
    ...pending(),
    status: "failed",
    userId: USER_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    startedAt: "2026-07-19T00:00:01.000Z",
    completedAt: "2026-07-19T00:00:05.000Z",
    error: {
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "The provider rejected the call.",
      retryable: false,
    },
    latencyMs: 4_000,
  };
}

function cancelledExecution(
  dispatchMayHaveBegun = false,
): CancelledExecutionRecord {
  return {
    ...pending(),
    status: "cancelled",
    userId: USER_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    completedAt: "2026-07-19T00:00:02.000Z",
    error: {
      code: TOOL_ERROR_CODES.EXECUTION_CANCELLED,
      message: dispatchMayHaveBegun
        ? "Execution was cancelled after provider dispatch may have begun; upstream work may still complete."
        : "Execution was cancelled before provider dispatch.",
      retryable: false,
    },
    latencyMs: 2_000,
    cancellation: { dispatchMayHaveBegun },
  };
}

function taskExecutor(
  getImplementation: () => Promise<ExecutionRecord> = async () => running(),
): McpExecutor & {
  execute: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  return {
    execute: vi.fn(
      async (_request: McpExecuteRequest): Promise<TerminalExecution> =>
        succeeded(),
    ),
    start: vi.fn(async () => pending()),
    get: vi.fn(getImplementation),
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

async function post(
  app: ReturnType<typeof createMcpGatewayApp>,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(sessionId === undefined ? {} : { "Mcp-Session-Id": sessionId }),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(
  app: ReturnType<typeof createMcpGatewayApp>,
): Promise<Response> {
  return post(
    app,
    rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tasks: {} },
      clientInfo: { name: "tasks-test", version: "1.0.0" },
    }),
  );
}

const taskCall = rpc(
  "tools/call",
  {
    name: "twilio.start_call",
    arguments: {
      to: "+966500000000",
      from: "+12025550173",
      voiceAgentId: "vag_mcp_tasks",
    },
    _meta: { "dev.eyeball/connectionId": "conn_mcp_tasks" },
    task: { ttl: 120_000 },
  },
  "call-task-1",
);

describe("negotiated MCP Tasks", () => {
  it("advertises Tasks only to an opted-in stateful session", async () => {
    const execution = taskExecutor();
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
    });

    const initialized = await initialize(app);
    expect(initialized.headers.get("Mcp-Session-Id")).toBe(SESSION_ID);
    await expect(initialized.json()).resolves.toMatchObject({
      result: {
        capabilities: {
          tools: { listChanged: true },
          tasks: { requests: { tools: { call: {} } } },
        },
      },
    });

    const listed = await post(app, rpc("tools/list"), SESSION_ID);
    const listedBody = (await listed.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    expect(
      listedBody.result.tools.find(({ name }) => name === "twilio.start_call"),
    ).toMatchObject({ execution: { taskSupport: "required" } });
    expect(
      listedBody.result.tools.find(({ name }) => name === "gmail.list_emails"),
    ).toMatchObject({ execution: { taskSupport: "optional" } });

    const legacy = await post(app, rpc("tools/list"));
    const legacyBody = (await legacy.json()) as {
      result: { tools: Array<Record<string, unknown>> };
    };
    const legacyStartCall = legacyBody.result.tools.find(
      ({ name }) => name === "twilio.start_call",
    );
    expect(legacyStartCall).toBeDefined();
    expect(legacyStartCall).not.toHaveProperty("execution");

    const legacyCall = await post(
      app,
      rpc("tools/call", {
        name: "gmail.list_emails",
        arguments: {},
        task: {},
      }),
    );
    await expect(legacyCall.json()).resolves.toMatchObject({
      result: { structuredContent: expect.anything() },
    });
    expect(execution.execute).toHaveBeenCalledTimes(1);
  });

  it("retains the legacy experimental Tasks opt-in as a compatibility alias", async () => {
    const app = createMcpGatewayApp({
      executor: taskExecutor(),
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
    });
    const initialized = await post(
      app,
      rpc("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { experimental: { tasks: {} } },
        clientInfo: { name: "legacy-tasks-test", version: "1.0.0" },
      }),
    );
    await expect(initialized.json()).resolves.toMatchObject({
      result: {
        capabilities: { tasks: { requests: { tools: { call: {} } } } },
      },
    });
  });

  it("allocates async work once and exposes task status plus terminal result", async () => {
    let executionRecord: ExecutionRecord = running();
    const execution = taskExecutor(async () => executionRecord);
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
      taskPollMs: 60_000,
    });
    await initialize(app);

    const created = await post(app, taskCall, SESSION_ID);
    await expect(created.json()).resolves.toMatchObject({
      result: {
        task: {
          taskId: TASK_ID,
          status: "working",
          ttl: 120_000,
          pollInterval: 60_000,
        },
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: TASK_ID },
        },
      },
    });
    expect(execution.start).toHaveBeenCalledTimes(1);
    expect(execution.start).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: API_KEY,
        userId: USER_ID,
        connectionId: "conn_mcp_tasks",
        tool: "twilio.start_call",
        idempotencyKey: `mcp:${SESSION_ID}:call-task-1`,
      }),
    );

    const replay = await post(
      app,
      {
        ...taskCall,
        params: {
          ...taskCall.params,
          task: { ttl: 1 },
        },
      },
      SESSION_ID,
    );
    await expect(replay.json()).resolves.toMatchObject({
      result: { task: { taskId: TASK_ID, ttl: 120_000 } },
    });

    const working = await post(
      app,
      rpc("tasks/get", { taskId: TASK_ID }, "get-working"),
      SESSION_ID,
    );
    await expect(working.json()).resolves.toMatchObject({
      result: { taskId: TASK_ID, status: "working" },
    });

    executionRecord = succeeded();
    const completed = await post(
      app,
      rpc("tasks/get", { taskId: TASK_ID }, "get-completed"),
      SESSION_ID,
    );
    await expect(completed.json()).resolves.toMatchObject({
      result: { taskId: TASK_ID, status: "completed" },
    });

    const result = await post(
      app,
      rpc("tasks/result", { taskId: TASK_ID }, "task-result"),
      SESSION_ID,
    );
    await expect(result.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          callId: "call_mcp_task",
          status: "completed",
          durationSeconds: 4,
        },
        _meta: {
          "dev.eyeball/execution": {
            executionId: TASK_ID,
            status: "succeeded",
          },
          "io.modelcontextprotocol/related-task": { taskId: TASK_ID },
        },
      },
    });
    expect(execution.start).toHaveBeenCalledTimes(2);

    await app.request("/mcp", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Mcp-Session-Id": SESSION_ID,
      },
    });
  });

  it("marks task-backed tool failures failed while preserving the tool result", async () => {
    const execution = taskExecutor(async () => failed());
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
      taskPollMs: 60_000,
    });
    await initialize(app);
    await post(app, taskCall, SESSION_ID);

    const status = await post(
      app,
      rpc("tasks/get", { taskId: TASK_ID }),
      SESSION_ID,
    );
    await expect(status.json()).resolves.toMatchObject({
      result: {
        taskId: TASK_ID,
        status: "failed",
        statusMessage: "The provider rejected the call.",
      },
    });

    const result = await post(
      app,
      rpc("tasks/result", { taskId: TASK_ID }),
      SESSION_ID,
    );
    await expect(result.json()).resolves.toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("provider_error") }],
        _meta: {
          "io.modelcontextprotocol/related-task": { taskId: TASK_ID },
        },
      },
    });
  });

  it.each(
    sessionStores,
  )("reconstructs cancelled tasks and returns the underlying cancellation result with $name", async ({
    create,
  }) => {
    const sessions = await create();
    try {
      const execution = taskExecutor(async () => cancelledExecution(true));
      const app = createMcpGatewayApp({
        executor: execution,
        apiKey: API_KEY,
        userId: USER_ID,
        sessionIdFactory: () => SESSION_ID,
        taskPollMs: 60_000,
        sessionStore: sessions.store,
      });
      await initialize(app);
      await post(app, taskCall, SESSION_ID);

      const status = await post(
        app,
        rpc("tasks/get", { taskId: TASK_ID }, "cancelled-status"),
        SESSION_ID,
      );
      await expect(status.json()).resolves.toMatchObject({
        result: {
          taskId: TASK_ID,
          status: "cancelled",
          statusMessage: expect.stringContaining("best effort"),
        },
      });

      const result = await post(
        app,
        rpc("tasks/result", { taskId: TASK_ID }, "cancelled-result"),
        SESSION_ID,
      );
      await expect(result.json()).resolves.toMatchObject({
        result: {
          isError: true,
          content: [{ text: expect.stringContaining("execution_cancelled") }],
          _meta: {
            "dev.eyeball/execution": {
              executionId: TASK_ID,
              status: "cancelled",
            },
            "io.modelcontextprotocol/related-task": { taskId: TASK_ID },
          },
        },
      });
      await expect(sessions.store.get(SESSION_ID)).resolves.toMatchObject({
        tasks: {
          [TASK_ID]: {
            status: "cancelled",
            executionStatus: "cancelled",
          },
        },
      });
    } finally {
      await sessions.close();
    }
  });

  it("requires task augmentation for required tools and scopes task IDs to sessions", async () => {
    const execution = taskExecutor();
    let sessionIndex = 0;
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => `mcp_scope_${++sessionIndex}`,
      taskPollMs: 60_000,
    });
    const first = (await initialize(app)).headers.get("Mcp-Session-Id") ?? "";
    const second = (await initialize(app)).headers.get("Mcp-Session-Id") ?? "";

    const missingTask = await post(
      app,
      rpc("tools/call", {
        name: "twilio.start_call",
        arguments: {},
      }),
      first,
    );
    await expect(missingTask.json()).resolves.toMatchObject({
      error: { code: -32601, message: expect.stringContaining("required") },
    });

    await post(app, taskCall, first);
    const crossSession = await post(
      app,
      rpc("tasks/get", { taskId: TASK_ID }),
      second,
    );
    await expect(crossSession.json()).resolves.toMatchObject({
      error: { code: -32602, message: "Task not found." },
    });
  });

  it("advertises and dispatches cancellation only when the executor supports it", async () => {
    const cancel = vi.fn(async () => ({
      kind: "cancelled" as const,
      execution: cancelledExecution(),
    }));
    const execution = { ...taskExecutor(), cancel };
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
      taskPollMs: 60_000,
    });
    const initialized = await initialize(app);
    await expect(initialized.json()).resolves.toMatchObject({
      result: { capabilities: { tasks: { cancel: {} } } },
    });
    await post(app, taskCall, SESSION_ID);

    const cancelled = await post(
      app,
      rpc("tasks/cancel", { taskId: TASK_ID }),
      SESSION_ID,
    );
    const cancelledBody = (await cancelled.json()) as {
      result: Record<string, unknown>;
    };
    expect(cancelledBody).toMatchObject({
      result: {
        taskId: TASK_ID,
        status: "cancelled",
        statusMessage: expect.stringContaining("before provider dispatch"),
      },
    });
    expect(cancelledBody.result).not.toHaveProperty("_meta");
    expect(cancel).toHaveBeenCalledWith({
      apiKey: API_KEY,
      executionId: TASK_ID,
    });

    const withoutCancellation = createMcpGatewayApp({
      executor: taskExecutor(),
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => "mcp_tasks_without_cancel",
      taskPollMs: 60_000,
    });
    await initialize(withoutCancellation);
    await post(withoutCancellation, taskCall, "mcp_tasks_without_cancel");
    const unavailable = await post(
      withoutCancellation,
      rpc("tasks/cancel", { taskId: TASK_ID }),
      "mcp_tasks_without_cancel",
    );
    await expect(unavailable.json()).resolves.toMatchObject({
      error: { code: -32601, message: "Method not found" },
    });
  });

  it("persists a downstream terminal race and rejects cancellation as invalid params", async () => {
    const execution = {
      ...taskExecutor(),
      cancel: vi.fn(async () => ({
        kind: "already_terminal" as const,
        execution: succeeded(),
      })),
    };
    const app = createMcpGatewayApp({
      executor: execution,
      apiKey: API_KEY,
      userId: USER_ID,
      sessionIdFactory: () => SESSION_ID,
      taskPollMs: 60_000,
    });
    await initialize(app);
    await post(app, taskCall, SESSION_ID);

    const response = await post(
      app,
      rpc("tasks/cancel", { taskId: TASK_ID }, "terminal-race"),
      SESSION_ID,
    );
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
        message: expect.stringContaining("completed"),
      },
    });
    const refreshed = await post(
      app,
      rpc("tasks/get", { taskId: TASK_ID }, "terminal-after-race"),
      SESSION_ID,
    );
    await expect(refreshed.json()).resolves.toMatchObject({
      result: { taskId: TASK_ID, status: "completed" },
    });
  });

  it.each(
    sessionStores,
  )("does not let an in-flight status refresh overwrite cancellation with $name", async ({
    create,
  }) => {
    const sessions = await create();
    try {
      let resolveStatus: ((record: ExecutionRecord) => void) | undefined;
      const get = vi.fn(
        () =>
          new Promise<ExecutionRecord>((resolve) => {
            resolveStatus = resolve;
          }),
      );
      const execution = {
        ...taskExecutor(),
        get,
        cancel: vi.fn(async () => ({
          kind: "cancelled" as const,
          execution: cancelledExecution(),
        })),
      };
      const app = createMcpGatewayApp({
        executor: execution,
        apiKey: API_KEY,
        userId: USER_ID,
        sessionIdFactory: () => SESSION_ID,
        taskPollMs: 60_000,
        sessionStore: sessions.store,
      });
      await initialize(app);
      await post(app, taskCall, SESSION_ID);

      const refreshing = post(
        app,
        rpc("tasks/get", { taskId: TASK_ID }, "refresh-race"),
        SESSION_ID,
      );
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      const cancelled = await post(
        app,
        rpc("tasks/cancel", { taskId: TASK_ID }, "cancel-race"),
        SESSION_ID,
      );
      resolveStatus?.(running());

      await expect(cancelled.json()).resolves.toMatchObject({
        result: { taskId: TASK_ID, status: "cancelled" },
      });
      await expect((await refreshing).json()).resolves.toMatchObject({
        result: { taskId: TASK_ID, status: "cancelled" },
      });
    } finally {
      await sessions.close();
    }
  });

  it("removes expired task records atomically from PGlite", async () => {
    const bundle = await createPgliteMcpGatewayStoreBundle();
    const clock = new ManualClock();
    try {
      const app = createMcpGatewayApp({
        executor: taskExecutor(),
        apiKey: API_KEY,
        userId: USER_ID,
        sessionIdFactory: () => SESSION_ID,
        taskPollMs: 60_000,
        sessionStore: bundle.sessionStore,
        clock,
      });
      await initialize(app);
      await post(app, taskCall, SESSION_ID);

      clock.advance(120_001);
      const expired = await post(
        app,
        rpc("tasks/get", { taskId: TASK_ID }, "expired-task"),
        SESSION_ID,
      );
      await expect(expired.json()).resolves.toMatchObject({
        error: { code: -32602, message: "Task not found." },
      });
      await expect(bundle.sessionStore.get(SESSION_ID)).resolves.toMatchObject({
        tasks: {},
      });
    } finally {
      await bundle.close();
    }
  });
});
