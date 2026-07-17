import { EyeballError, TOOL_ERROR_CODES } from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import { Eyeball, executeToolCalls } from "../src/index.js";

type FetchHandler = (request: Request) => Promise<Response> | Response;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function testFetch(
  handler: FetchHandler,
  requests: Request[] = [],
): typeof globalThis.fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return handler(request);
  }) as typeof globalThis.fetch;
}

function client(
  fetchImpl: typeof globalThis.fetch,
  options: {
    clock?: { now(): number };
    sleep?: (milliseconds: number) => Promise<void>;
    userId?: string;
  } = {},
): Eyeball {
  return new Eyeball({
    apiKey: "ey_test_sdk",
    baseUrl: "https://executor.example.test///",
    fetch: fetchImpl,
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

function immediateSuccess(tool: string, output: unknown): Response {
  return jsonResponse({
    executionId: "exe_sdk_sync",
    tool,
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    status: "succeeded",
    output,
    latencyMs: 2,
  });
}

describe("Eyeball SDK", () => {
  it("discovers and converts the local catalog without an HTTP request", async () => {
    const fetchImpl = testFetch(() => {
      throw new Error("tool discovery must remain local");
    });
    const eb = client(fetchImpl);

    const canonical = await eb.tools.get({
      toolkits: ["gmail"],
      format: "canonical",
    });
    const anthropic = await eb.tools.get({
      toolkits: ["gmail"],
      format: "anthropic",
    });
    const openai = await eb.tools.get({
      toolkits: ["gmail"],
      format: "openai",
    });

    expect(canonical.tools).toBe(canonical.raw);
    expect(canonical.raw).toHaveLength(8);
    expect(canonical.raw.every((tool) => tool.toolkit === "gmail")).toBe(true);
    expect(canonical.raw.map((tool) => tool.name)).toEqual(
      [...canonical.raw.map((tool) => tool.name)].sort(),
    );
    expect(anthropic.raw).toEqual(canonical.raw);
    expect(anthropic.tools[0]).toMatchObject({
      name: "gmail__add_email_label",
      input_schema: canonical.raw[0]?.inputSchema,
    });
    expect(openai.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "gmail__add_email_label",
        parameters: canonical.raw[0]?.inputSchema,
      },
    });
    expect(anthropic.nameMap.wireToCanonical.gmail__send_email).toBe(
      "gmail.send_email",
    );
  });

  it("searches one deterministic local catalog view without an HTTP request", async () => {
    const fetchImpl = testFetch(() => {
      throw new Error("tool search must remain local");
    });
    const eb = client(fetchImpl);

    const result = await eb.tools.search({
      query: "gmail send email",
      toolkits: ["gmail"],
      capability: "email",
      limit: 3,
      userId: "user_search",
    });

    expect(result.tools[0]).toMatchObject({
      name: "gmail.send_email",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(result.tools).toHaveLength(3);
    await expect(
      eb.tools.search({ query: "", limit: 3 }),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: "query must be a non-empty string.",
    });
  });

  it("includes async MCP tools only after Tasks support is negotiated", async () => {
    const eb = client(
      testFetch(() => {
        throw new Error("MCP discovery must remain local");
      }),
    );

    const withoutTasks = await eb.tools.get({
      toolkits: ["twilio"],
      format: "mcp",
    });
    const withTasks = await eb.tools.get({
      toolkits: ["twilio"],
      format: "mcp",
      includeAsync: true,
    });

    expect(
      withoutTasks.tools.some(({ name }) => name === "twilio.start_call"),
    ).toBe(false);
    expect(
      withTasks.tools.find(({ name }) => name === "twilio.start_call"),
    ).toMatchObject({ execution: { taskSupport: "required" } });
  });

  it("binds AI SDK execute callbacks to the configured user", async () => {
    const requests: Request[] = [];
    const fetchImpl = testFetch(async (request) => {
      const body = (await request.json()) as { tool: string };
      return immediateSuccess(body.tool, { emails: [] });
    }, requests);
    const eb = client(fetchImpl, { userId: "user_sdk" });
    const bundle = await eb.tools.get({
      toolkits: ["gmail"],
      format: "ai-sdk",
    });
    const execute = bundle.tools.gmail__list_emails?.execute;
    if (execute === undefined) {
      throw new Error("Expected a bound gmail.list_emails execute callback.");
    }

    await expect(execute({})).resolves.toEqual({ emails: [] });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/execute");
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer ey_test_sdk",
    );
    expect(requests[0]?.headers.get("Idempotency-Key")).toBeNull();
    await expect(requests[0]?.json()).resolves.toEqual({
      tool: "gmail.list_emails",
      userId: "user_sdk",
      input: {},
      mode: "sync",
    });
  });

  it("accepts restricted names and generates mutation idempotency keys", async () => {
    const requests: Request[] = [];
    const fetchImpl = testFetch(async (request) => {
      const body = (await request.json()) as { tool: string };
      return immediateSuccess(body.tool, {
        messageId: "msg_sdk",
        acceptedRecipients: ["recipient@example.com"],
      });
    }, requests);
    const eb = client(fetchImpl, { userId: "user_sdk" });
    const input = {
      to: ["recipient@example.com"],
      subject: "SDK delivery",
      body: "Generated through the SDK.",
    } as const;

    await eb.tools.execute("gmail__send_email", { input });
    await eb.tools.execute("gmail.send_email", {
      input,
      idempotencyKey: "stable-retry-key",
    });

    expect(requests[0]?.headers.get("Idempotency-Key")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(requests[1]?.headers.get("Idempotency-Key")).toBe(
      "stable-retry-key",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      tool: "gmail.send_email",
      userId: "user_sdk",
      input,
      mode: "sync",
    });
  });

  it("defaults async tools from annotations and waits for canonical output", async () => {
    const requests: Request[] = [];
    const sleeps: number[] = [];
    let now = 1_000;
    let polls = 0;
    const fetchImpl = testFetch(async (request) => {
      if (request.method === "POST") {
        return jsonResponse(
          {
            executionId: "exe_sdk_async",
            tool: "twilio.start_call",
            toolVersion: "1.0.0",
            catalogVersion: "1.1",
            status: "pending",
          },
          202,
        );
      }
      polls += 1;
      if (polls === 1) {
        return jsonResponse({
          executionId: "exe_sdk_async",
          tool: "twilio.start_call",
          toolVersion: "1.0.0",
          catalogVersion: "1.1",
          status: "running",
          userId: "user_sdk",
          createdAt: "2026-07-17T00:00:00.000Z",
          startedAt: "2026-07-17T00:00:00.001Z",
        });
      }
      return jsonResponse({
        executionId: "exe_sdk_async",
        tool: "twilio.start_call",
        toolVersion: "1.0.0",
        catalogVersion: "1.1",
        status: "succeeded",
        userId: "user_sdk",
        createdAt: "2026-07-17T00:00:00.000Z",
        startedAt: "2026-07-17T00:00:00.001Z",
        completedAt: "2026-07-17T00:00:00.010Z",
        output: { callId: "call_sdk", state: "completed" },
        latencyMs: 9,
      });
    }, requests);
    const eb = client(fetchImpl, {
      userId: "user_sdk",
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(
      eb.tools.run(
        "twilio__start_call",
        {
          to: "+966500000000",
          from: "+12025550173",
          voiceAgentId: "vag_sdk",
        },
        { pollMs: 7, timeoutMs: 50 },
      ),
    ).resolves.toEqual({ callId: "call_sdk", state: "completed" });
    expect(sleeps).toEqual([7]);
    expect(requests).toHaveLength(3);
    expect(requests[0]?.headers.get("Idempotency-Key")).not.toBeNull();
    await expect(requests[0]?.json()).resolves.toMatchObject({
      tool: "twilio.start_call",
      userId: "user_sdk",
      mode: "async",
    });
  });

  it("normalizes an in-flight idempotency replay to the immediate pending contract", async () => {
    const eb = client(
      testFetch(() =>
        jsonResponse(
          {
            executionId: "exe_sdk_replay",
            tool: "twilio.start_call",
            toolVersion: "1.0.0",
            catalogVersion: "1.1",
            status: "running",
          },
          202,
        ),
      ),
      { userId: "user_sdk" },
    );

    await expect(
      eb.tools.execute("twilio.start_call", {
        input: {
          to: "+966500000000",
          from: "+12025550173",
          voiceAgentId: "vag_sdk",
        },
        idempotencyKey: "stable-call-retry",
      }),
    ).resolves.toEqual({
      executionId: "exe_sdk_replay",
      tool: "twilio.start_call",
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      status: "pending",
    });
  });

  it("bounds polling with a timeout and maps normalized API errors", async () => {
    const sleeps: number[] = [];
    let now = 0;
    const pendingFetch = testFetch(() =>
      jsonResponse({
        executionId: "exe_never",
        tool: "twilio.start_call",
        toolVersion: "1.0.0",
        catalogVersion: "1.1",
        status: "pending",
        userId: "user_sdk",
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    );
    const pollingClient = client(pendingFetch, {
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
      },
    });

    await expect(
      pollingClient.executions.wait("exe_never", {
        pollMs: 5,
        timeoutMs: 12,
      }),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.TIMEOUT,
      retryable: false,
    });
    expect(sleeps).toEqual([5, 5, 2]);

    const failingClient = client(
      testFetch(() =>
        jsonResponse(
          {
            requestId: "req_rate_limit",
            error: {
              code: "rate_limited",
              message: "Executor quota exceeded.",
              retryable: true,
              retryAfter: 7,
              provider: { toolkit: "gmail", status: 429 },
            },
          },
          429,
        ),
      ),
    );
    await expect(
      failingClient.executions.get("exe_rate_limit"),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      retryable: true,
      retryAfter: 7,
      providerDetail: { toolkit: "gmail", status: 429 },
    });
  });

  it("creates dev connections and explains the private cloud boundary", async () => {
    const requests: Request[] = [];
    const eb = client(
      testFetch(
        () =>
          jsonResponse(
            {
              connectionId: "conn_sdk_dev",
              redirectUrl: null,
              status: "connected",
            },
            201,
          ),
        requests,
      ),
      { userId: "user_sdk" },
    );

    await expect(eb.connections.create({ toolkit: "gmail" })).resolves.toEqual({
      connectionId: "conn_sdk_dev",
      redirectUrl: null,
      status: "connected",
    });
    await expect(requests[0]?.json()).resolves.toEqual({
      userId: "user_sdk",
      toolkit: "gmail",
    });

    const cloudless = client(
      testFetch(() => new Response("404 Not Found", { status: 404 })),
      { userId: "user_sdk" },
    );
    await expect(
      cloudless.connections.create({ toolkit: "gmail" }),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.NOT_SUPPORTED,
      message: expect.stringContaining("private eyeball-cloud Auth Vault"),
    });
  });
});

describe("executeToolCalls", () => {
  it("returns framework-native success and normalized error blocks", async () => {
    const run = vi.fn(
      async (name: string, _input: unknown, _options: unknown) => {
        if (name === "gmail__get_email") {
          throw new EyeballError({
            code: TOOL_ERROR_CODES.NOT_FOUND,
            message: "Message not found.",
          });
        }
        return { emails: [] };
      },
    );
    const eb = { tools: { run } } as unknown as Eyeball;

    const anthropic = await executeToolCalls(eb, [
      {
        type: "tool_use",
        id: "toolu_list",
        name: "gmail__list_emails",
        input: {},
      },
      {
        type: "tool_use",
        id: "toolu_get",
        name: "gmail__get_email",
        input: { messageId: "missing" },
      },
    ]);
    expect(anthropic).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_list",
        content: JSON.stringify({ emails: [] }),
      },
      {
        type: "tool_result",
        tool_use_id: "toolu_get",
        content: JSON.stringify({
          error: {
            code: "not_found",
            message: "Message not found.",
            retryable: false,
          },
        }),
        is_error: true,
      },
    ]);

    const openai = await executeToolCalls(eb, [
      {
        id: "call_list",
        type: "function",
        function: {
          name: "gmail__list_emails",
          arguments: JSON.stringify({ query: "invoice" }),
        },
      },
      {
        id: "call_invalid",
        type: "function",
        function: {
          name: "gmail__list_emails",
          arguments: "{not-json",
        },
      },
    ]);
    expect(openai).toEqual([
      {
        role: "tool",
        tool_call_id: "call_list",
        content: JSON.stringify({ emails: [] }),
      },
      {
        role: "tool",
        tool_call_id: "call_invalid",
        content: JSON.stringify({
          error: {
            code: "invalid_input",
            message: "OpenAI tool-call arguments must contain valid JSON.",
            retryable: false,
          },
        }),
      },
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(
      1,
      "gmail__list_emails",
      {},
      {
        idempotencyKey: "anthropic:toolu_list",
      },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "gmail__get_email",
      { messageId: "missing" },
      { idempotencyKey: "anthropic:toolu_get" },
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      "gmail__list_emails",
      { query: "invoice" },
      { idempotencyKey: "openai:call_list" },
    );
  });

  it("redacts unexpected internal errors from model-facing results", async () => {
    const eb = {
      tools: {
        run: async () => {
          throw new Error("internal detail containing fixture:SECRET_TOKEN");
        },
      },
    } as unknown as Eyeball;

    const [result] = await executeToolCalls(eb, [
      {
        type: "tool_use",
        id: "toolu_redacted",
        name: "gmail__list_emails",
        input: {},
      },
    ]);

    expect(result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_redacted",
      content: JSON.stringify({
        error: {
          code: "provider_error",
          message: "Tool execution failed unexpectedly.",
          retryable: false,
        },
      }),
      is_error: true,
    });
    expect(result?.content).not.toContain("SECRET_TOKEN");
  });
});
