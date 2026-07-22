import {
  buildNameMap,
  EyeballError,
  TOOL_ERROR_CODES,
  validateCanonicalToolName,
} from "@eyeball/core";
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

  it("uploads file content and reuses the returned attachment reference", async () => {
    const requests: Request[] = [];
    const fetchImpl = testFetch(async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/v1/files") {
        return jsonResponse(
          {
            fileId: "file_sdk_attachment",
            name: "hello.txt",
            mimeType: "text/plain",
            size: 5,
            expiresAt: "2026-07-17T01:00:00.000Z",
          },
          201,
        );
      }
      const body = (await request.json()) as { tool: string };
      return immediateSuccess(body.tool, {
        messageId: "msg_sdk_attachment",
        acceptedRecipients: ["recipient@example.com"],
      });
    }, requests);
    const eb = client(fetchImpl, { userId: "user_sdk" });

    const attachment = await eb.files.upload({
      name: "hello.txt",
      mimeType: "text/plain",
      content: "hello",
    });
    await eb.tools.execute("gmail.send_email", {
      input: {
        to: ["recipient@example.com"],
        subject: "SDK attachment",
        body: "Attached through the SDK.",
        attachments: [attachment],
      },
      idempotencyKey: "sdk-attachment",
    });

    expect(attachment).toEqual({
      fileId: "file_sdk_attachment",
      name: "hello.txt",
      mimeType: "text/plain",
    });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/v1/files");
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer ey_test_sdk",
    );
    await expect(requests[0]?.json()).resolves.toEqual({
      name: "hello.txt",
      mimeType: "text/plain",
      content: "aGVsbG8=",
    });
    await expect(requests[1]?.json()).resolves.toMatchObject({
      tool: "gmail.send_email",
      input: { attachments: [attachment] },
    });
  });

  it("lists staged-file metadata without adding the client default user", async () => {
    const requests: Request[] = [];
    const expiresAt = "2026-07-17T01:00:00.000Z";
    let call = 0;
    const eb = client(
      testFetch(() => {
        call += 1;
        return jsonResponse(
          call === 1
            ? {
                files: [
                  {
                    fileId: "file_sdk_first",
                    name: "first.txt",
                    mimeType: "text/plain",
                    size: 5,
                    expiresAt,
                  },
                ],
                nextCursor: "cursor_sdk_next",
              }
            : { files: [] },
        );
      }, requests),
      { userId: "user_must_not_be_serialized" },
    );

    await expect(eb.files.list()).resolves.toEqual({
      files: [
        {
          fileId: "file_sdk_first",
          name: "first.txt",
          mimeType: "text/plain",
          size: 5,
          expiresAt,
        },
      ],
      nextCursor: "cursor_sdk_next",
    });
    await expect(
      eb.files.list({ cursor: "cursor_sdk_next", limit: 25 }),
    ).resolves.toEqual({ files: [] });
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/v1/files",
      "/v1/files",
    ]);
    expect(new URL(requests[0]?.url ?? "").search).toBe("");
    expect(new URL(requests[1]?.url ?? "").search).toBe(
      "?cursor=cursor_sdk_next&limit=25",
    );
    expect(new URL(requests[0]?.url ?? "").searchParams.has("userId")).toBe(
      false,
    );
  });

  it("validates file list options before fetch and normalizes 403 and 422 errors", async () => {
    const requests: Request[] = [];
    let responseIndex = 0;
    const eb = client(
      testFetch(() => {
        responseIndex += 1;
        const status = responseIndex === 1 ? 403 : 422;
        return jsonResponse(
          {
            requestId: `req_files_${status}`,
            error: {
              code:
                status === 403 ? "auth_insufficient_scope" : "invalid_input",
              message:
                status === 403
                  ? "Project authority is required."
                  : "File cursor is invalid.",
              retryable: false,
            },
          },
          status,
        );
      }, requests),
    );
    for (const options of [
      { cursor: "" },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
    ]) {
      await expect(eb.files.list(options)).rejects.toMatchObject({
        code: TOOL_ERROR_CODES.INVALID_INPUT,
      });
    }
    expect(requests).toHaveLength(0);
    const forbidden = eb.files.list();
    await expect(forbidden).rejects.toBeInstanceOf(EyeballError);
    await expect(forbidden).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      requestId: "req_files_403",
    });
    await expect(eb.files.list({ cursor: "unknown" })).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      requestId: "req_files_422",
    });
    expect(requests).toHaveLength(2);
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

  it("allows the authoritative executor to accept a server-newer canonical tool", async () => {
    const requests: Request[] = [];
    const eb = client(
      testFetch(async (request) => {
        const body = (await request.json()) as { tool: string };
        return immediateSuccess(body.tool, { serverNewer: true });
      }, requests),
      { userId: "user_sdk" },
    );

    await expect(
      eb.tools.run("future-provider.server_new_tool", { value: 1 }),
    ).resolves.toEqual({ serverNewer: true });
    await expect(requests[0]?.json()).resolves.toMatchObject({
      tool: "future-provider.server_new_tool",
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

  it("preserves safe execution provenance and retryAfter across get, list, and wait", async () => {
    let waitReads = 0;
    let now = 0;
    const safe = {
      executionId: "exe_sdk_safe",
      tool: "gmail.send_email",
      toolVersion: "1.0.0",
      catalogVersion: "2026.07.21",
      userId: "user_sdk",
      createdAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:00.010Z",
      latencyMs: 10,
      status: "succeeded",
      output: { messageId: "msg_sdk_safe" },
      replayed: true,
      source: { kind: "voice_session", sessionId: "session_sdk_safe" },
      attachments: {
        count: 2,
        fileIds: ["file_sdk_one", "file_sdk_two"],
      },
    };
    const eb = client(
      testFetch((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/executions") {
          return jsonResponse({ executions: [safe] });
        }
        if (path.endsWith("/exe_sdk_wait")) {
          waitReads += 1;
          if (waitReads === 1) {
            return jsonResponse({
              ...safe,
              executionId: "exe_sdk_wait",
              status: "running",
              completedAt: undefined,
              latencyMs: undefined,
              output: undefined,
            });
          }
          return jsonResponse({
            executionId: "exe_sdk_wait",
            tool: safe.tool,
            toolVersion: safe.toolVersion,
            catalogVersion: safe.catalogVersion,
            userId: safe.userId,
            createdAt: safe.createdAt,
            completedAt: safe.completedAt,
            latencyMs: safe.latencyMs,
            status: "failed",
            error: {
              code: "provider_rate_limited",
              message: "Retry later.",
              retryable: true,
              retryAfter: 12,
            },
            replayed: true,
            source: safe.source,
            attachments: safe.attachments,
          });
        }
        return jsonResponse(safe);
      }),
      {
        clock: { now: () => now },
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );

    await expect(eb.executions.get("exe_sdk_safe")).resolves.toMatchObject({
      replayed: true,
      source: { kind: "voice_session", sessionId: "session_sdk_safe" },
      attachments: {
        count: 2,
        fileIds: ["file_sdk_one", "file_sdk_two"],
      },
    });
    await expect(eb.executions.list()).resolves.toMatchObject({
      executions: [{ replayed: true, attachments: safe.attachments }],
    });
    await expect(
      eb.executions.wait("exe_sdk_wait", { pollMs: 1, timeoutMs: 10 }),
    ).resolves.toMatchObject({
      status: "failed",
      error: { retryAfter: 12 },
      replayed: true,
      source: safe.source,
      attachments: safe.attachments,
    });
  });

  it("cancels an execution with an empty body and returns its durable disposition", async () => {
    const requests: Request[] = [];
    const cancelled = {
      executionId: "exe_sdk_cancel/path",
      tool: "gmail.send_email",
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      userId: "user_sdk",
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
    } as const;
    const eb = client(
      testFetch(() => jsonResponse(cancelled), requests),
      { userId: "user_sdk" },
    );

    await expect(eb.executions.cancel(cancelled.executionId)).resolves.toEqual(
      cancelled,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/executions/exe_sdk_cancel%2Fpath/cancel",
    );
    expect(requests[0]?.headers.get("Content-Type")).toBeNull();
    await expect(requests[0]?.text()).resolves.toBe("");
  });

  it("stops wait on cancellation and run throws its normalized error", async () => {
    const cancelled = {
      executionId: "exe_sdk_cancelled",
      tool: "twilio.start_call",
      toolVersion: "1.0.0",
      catalogVersion: "1.1",
      userId: "user_sdk",
      createdAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:00.010Z",
      latencyMs: 10,
      status: "cancelled",
      error: {
        code: "execution_cancelled",
        message:
          "Execution was cancelled after provider dispatch may have begun; upstream work may still complete.",
        retryable: false,
      },
      cancellation: { dispatchMayHaveBegun: true },
    } as const;
    const waitClient = client(testFetch(() => jsonResponse(cancelled)));
    await expect(
      waitClient.executions.wait(cancelled.executionId),
    ).resolves.toEqual(cancelled);

    const runClient = client(
      testFetch(() =>
        jsonResponse({
          executionId: cancelled.executionId,
          tool: cancelled.tool,
          toolVersion: cancelled.toolVersion,
          catalogVersion: cancelled.catalogVersion,
          status: cancelled.status,
          error: cancelled.error,
          cancellation: cancelled.cancellation,
          completedAt: cancelled.completedAt,
          latencyMs: cancelled.latencyMs,
        }),
      ),
      { userId: "user_sdk" },
    );
    await expect(
      runClient.tools.run(
        "twilio.start_call",
        {
          to: "+966500000000",
          from: "+12025550173",
          voiceAgentId: "vag_sdk",
        },
        { mode: "sync" },
      ),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.EXECUTION_CANCELLED,
      message: cancelled.error.message,
      retryable: false,
    });
  });

  it("preserves a normalized already-terminal cancellation conflict", async () => {
    const eb = client(
      testFetch(() =>
        jsonResponse(
          {
            requestId: "req_sdk_cancel_conflict",
            error: {
              code: "invalid_input",
              message:
                "Execution exe_sdk_done is already terminal with status succeeded.",
              retryable: false,
            },
          },
          409,
        ),
      ),
    );

    await expect(eb.executions.cancel("exe_sdk_done")).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message:
        "Execution exe_sdk_done is already terminal with status succeeded.",
      requestId: "req_sdk_cancel_conflict",
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
      executionId: "exe_never",
    });
    expect(sleeps).toEqual([5, 5, 2]);

    const rateLimitRequests: Request[] = [];
    const rateLimitSleeps: number[] = [];
    const failingClient = client(
      testFetch(
        () =>
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
        rateLimitRequests,
      ),
      { sleep: async (milliseconds) => rateLimitSleeps.push(milliseconds) },
    );
    await expect(
      failingClient.executions.get("exe_rate_limit"),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      retryable: true,
      retryAfter: 7,
      providerDetail: { toolkit: "gmail", status: 429 },
      requestId: "req_rate_limit",
    });
    expect(rateLimitSleeps).toEqual([7_000]);
    expect(rateLimitRequests).toHaveLength(2);
  });

  it("does not automatically retry a rate-limited mutation", async () => {
    const requests: Request[] = [];
    const sleeps: number[] = [];
    const eb = client(
      testFetch(
        () =>
          jsonResponse(
            {
              requestId: "req_mutation_rate_limit",
              error: {
                code: "rate_limited",
                message: "Executor quota exceeded.",
                retryable: true,
                retryAfter: 3,
              },
            },
            429,
          ),
        requests,
      ),
      { sleep: async (milliseconds) => sleeps.push(milliseconds) },
    );

    await expect(
      eb.files.upload({
        name: "not-retried.txt",
        mimeType: "text/plain",
        content: "mutation",
      }),
    ).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.RATE_LIMITED,
      retryAfter: 3,
    });
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
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

  it("lists and deletes development connections", async () => {
    const requests: Request[] = [];
    const eb = client(
      testFetch((request) => {
        if (request.method === "DELETE") {
          return jsonResponse({
            connectionId: "conn_sdk_dev",
            status: "revoked",
          });
        }
        return jsonResponse({
          connections: [
            {
              connectionId: "conn_sdk_dev",
              userId: "user_sdk",
              toolkit: "gmail",
              status: "connected",
              createdAt: "2026-07-17T00:00:00.000Z",
              updatedAt: "2026-07-17T00:00:00.000Z",
            },
          ],
        });
      }, requests),
      { userId: "user_sdk" },
    );

    await expect(eb.connections.list()).resolves.toMatchObject({
      connections: [{ connectionId: "conn_sdk_dev" }],
    });
    await expect(eb.connections.delete("conn_sdk_dev")).resolves.toEqual({
      connectionId: "conn_sdk_dev",
      status: "revoked",
    });
    const [listRequest, deleteRequest] = requests;
    if (listRequest === undefined || deleteRequest === undefined) {
      throw new Error("Expected list and delete connection requests.");
    }
    expect(new URL(listRequest.url).pathname).toBe("/v1/connections");
    expect(new URL(deleteRequest.url).pathname).toBe(
      "/v1/connections/conn_sdk_dev",
    );
  });

  it("lists canonical triggers locally without an HTTP request", async () => {
    const fetchImpl = testFetch(() => {
      throw new Error("trigger discovery must remain local");
    });
    const eb = client(fetchImpl);

    await expect(
      eb.triggers.list({
        toolkits: ["gmail"],
        capability: "email",
        deliveryMode: "polling",
      }),
    ).resolves.toMatchObject([
      {
        name: "gmail.email_received",
        toolkit: "gmail",
        annotations: { deliveryMode: "polling" },
      },
    ]);
  });

  it("lists project trigger-event history without serializing the default user", async () => {
    const requests: Request[] = [];
    const response = {
      triggerEvents: [
        {
          arrivalId: "trgevt_sdk",
          eventId: "evt_trigger_sdk",
          subscriptionId: "trgsub_sdk",
          trigger: "slack.message_received",
          deliveryMode: "push",
          receivedAt: "2026-07-21T12:00:00.000Z",
          occurredAt: "2026-07-21T11:59:59.000Z",
          dedupStatus: "accepted",
          deliveryStatus: "succeeded",
          requestedWebhookEndpointIds: ["whe_sdk"],
          deliveryTargets: [
            {
              endpointId: "whe_sdk",
              deliveryId: "whd_sdk",
              status: "succeeded",
            },
          ],
          expiresAt: "2026-07-28T12:00:00.000Z",
        },
      ],
      nextCursor: "cursor+/=sdk",
    } as const;
    const eb = client(
      testFetch(() => jsonResponse(response), requests),
      { userId: "user_sdk_default" },
    );
    await expect(
      eb.triggerEvents.list({
        cursor: "cursor+/=sdk",
        limit: 25,
        subscriptionId: "trgsub_sdk",
        trigger: "slack.message_received",
      }),
    ).resolves.toEqual(response);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/trigger-events");
    expect(url.search).toBe(
      "?cursor=cursor%2B%2F%3Dsdk&limit=25&subscriptionId=trgsub_sdk&trigger=slack.message_received",
    );
    expect(url.searchParams.has("userId")).toBe(false);
  });

  it("rejects invalid trigger-event list options without fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ triggerEvents: [] })),
    );
    const eb = client(fetchImpl);
    for (const options of [
      { cursor: "" },
      { limit: 0 },
      { limit: 101 },
      { subscriptionId: "subscription_bad" },
      { trigger: "bad trigger" },
    ]) {
      await expect(
        eb.triggerEvents.list(options as never),
      ).rejects.toMatchObject({ code: TOOL_ERROR_CODES.INVALID_INPUT });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes trigger-event executor errors", async () => {
    const eb = client(
      testFetch(() =>
        jsonResponse(
          {
            error: {
              code: "auth_insufficient_scope",
              message:
                "Project-scoped trigger event history requires an unpinned project API key.",
              retryable: false,
            },
          },
          403,
        ),
      ),
    );
    await expect(eb.triggerEvents.list()).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      message:
        "Project-scoped trigger event history requires an unpinned project API key.",
    });
  });

  it("creates, lists, rotates, and deletes trigger subscriptions", async () => {
    const requests: Request[] = [];
    const subscription = {
      subscriptionId: "trgsub_sdk",
      projectId: "proj_sdk",
      userId: "user_sdk",
      trigger: "slack.message_received",
      connectionId: "conn_sdk_slack",
      webhookEndpointIds: ["whe_sdk"],
      status: "active",
      createdAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    } as const;
    const eb = client(
      testFetch((request) => {
        if (request.url.endsWith("/rotate-secret")) {
          return jsonResponse({
            subscriptionId: subscription.subscriptionId,
            ingestUrl:
              "https://executor.example.test/v1/ingest/trgsub_sdk/trgsec_rotated",
            rotatedAt: "2026-07-17T12:05:00.000Z",
          });
        }
        if (request.method === "POST") {
          return jsonResponse(
            {
              ...subscription,
              ingestUrl:
                "https://executor.example.test/v1/ingest/trgsub_sdk/trgsec_sdk",
            },
            201,
          );
        }
        if (request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        return jsonResponse({
          subscriptions: [subscription],
          nextCursor: "cursor_sdk",
        });
      }, requests),
      { userId: "user_sdk" },
    );

    await expect(
      eb.subscriptions.create({
        trigger: "slack.message_received",
        connectionId: "conn_sdk_slack",
        webhookEndpointIds: ["whe_sdk"],
        filters: { conversationId: "C_sdk" },
      }),
    ).resolves.toMatchObject({ subscriptionId: "trgsub_sdk" });
    await expect(
      eb.subscriptions.list({ cursor: "previous", limit: 10 }),
    ).resolves.toMatchObject({
      subscriptions: [{ subscriptionId: "trgsub_sdk" }],
      nextCursor: "cursor_sdk",
    });
    await expect(
      eb.subscriptions.rotateSecret("trgsub_sdk"),
    ).resolves.toMatchObject({
      subscriptionId: "trgsub_sdk",
      rotatedAt: "2026-07-17T12:05:00.000Z",
    });
    await expect(
      eb.subscriptions.delete("trgsub_sdk"),
    ).resolves.toBeUndefined();

    await expect(requests[0]?.json()).resolves.toEqual({
      trigger: "slack.message_received",
      userId: "user_sdk",
      connectionId: "conn_sdk_slack",
      webhookEndpointIds: ["whe_sdk"],
      filters: { conversationId: "C_sdk" },
    });
    expect(new URL(requests[1]?.url ?? "").search).toBe(
      "?userId=user_sdk&cursor=previous&limit=10",
    );
    expect(new URL(requests[2]?.url ?? "").pathname).toBe(
      "/v1/subscriptions/trgsub_sdk/rotate-secret",
    );
    expect(requests[2]?.method).toBe("POST");
    expect(new URL(requests[3]?.url ?? "").pathname).toBe(
      "/v1/subscriptions/trgsub_sdk",
    );
  });

  it("rejects cleartext non-loopback executor URLs without an explicit opt-in", () => {
    const options = {
      apiKey: "ey_test_sdk",
      baseUrl: "http://executor.example.test",
      fetch: testFetch(() => jsonResponse({})),
    };

    expect(() => new Eyeball(options)).toThrow("must use HTTPS");
    expect(
      () => new Eyeball({ ...options, allowInsecureHttp: true }),
    ).not.toThrow();
  });
});

describe("executeToolCalls", () => {
  const nameMap = buildNameMap(
    ["gmail.list_emails", "gmail.get_email"].map((name) => ({
      name: validateCanonicalToolName(name),
    })),
  );

  it("returns framework-native success and normalized error blocks", async () => {
    const run = vi.fn(
      async (name: string, _input: unknown, _options: unknown) => {
        if (name === "gmail.get_email") {
          throw new EyeballError({
            code: TOOL_ERROR_CODES.NOT_FOUND,
            message: "Message not found.",
          });
        }
        return { emails: [] };
      },
    );
    const eb = { tools: { run } } as unknown as Eyeball;

    const anthropic = await executeToolCalls(
      eb,
      [
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
      ],
      { nameMap },
    );
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

    const openai = await executeToolCalls(
      eb,
      [
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
      ],
      { nameMap },
    );
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
      "gmail.list_emails",
      {},
      {
        idempotencyKey: "anthropic:toolu_list",
      },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "gmail.get_email",
      { messageId: "missing" },
      { idempotencyKey: "anthropic:toolu_get" },
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      "gmail.list_emails",
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

    const [result] = await executeToolCalls(
      eb,
      [
        {
          type: "tool_use",
          id: "toolu_redacted",
          name: "gmail__list_emails",
          input: {},
        },
      ],
      { nameMap },
    );

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

  it("manages webhook endpoints, rotates secrets, and lists deliveries", async () => {
    const requests: Request[] = [];
    const endpoint = {
      endpointId: "whe_sdk",
      url: "https://receiver.example.test/hook",
      secretPrefix: "whsec_sdk_pre",
      events: ["execution.completed"],
      active: true,
      createdAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    } as const;
    const fetchImpl = testFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/v1/webhooks" && request.method === "POST") {
        return jsonResponse({ ...endpoint, secret: "whsec_sdk_secret" }, 201);
      }
      if (url.pathname === "/v1/webhooks" && request.method === "GET") {
        return jsonResponse({ webhooks: [endpoint], nextCursor: "next_sdk" });
      }
      if (
        url.pathname === "/v1/webhooks/whe_sdk" &&
        request.method === "PATCH"
      ) {
        return jsonResponse({ ...endpoint, active: false });
      }
      if (
        url.pathname === "/v1/webhooks/whe_sdk/rotate-secret" &&
        request.method === "POST"
      ) {
        return jsonResponse({
          endpointId: endpoint.endpointId,
          secretPrefix: "whsec_rotated",
          secret: "whsec_rotated_secret",
          rotatedAt: "2026-07-17T12:05:00.000Z",
        });
      }
      if (url.pathname === "/v1/webhooks/whe_sdk/deliveries") {
        return jsonResponse({
          deliveries: [
            {
              deliveryId: "whd_sdk",
              endpointId: endpoint.endpointId,
              eventId: "evt_sdk",
              eventType: "execution.succeeded",
              status: "succeeded",
              attempts: [],
              createdAt: "2026-07-17T12:01:00.000Z",
              completedAt: "2026-07-17T12:01:01.000Z",
            },
          ],
        });
      }
      if (
        url.pathname === "/v1/webhooks/whe_sdk" &&
        request.method === "DELETE"
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(
        `Unexpected webhook SDK request: ${request.method} ${url}`,
      );
    }, requests);
    const eb = client(fetchImpl);

    const created = await eb.webhooks.create({
      url: endpoint.url,
      events: ["execution.completed"],
    });
    const page = await eb.webhooks.list({ cursor: "cursor_sdk", limit: 25 });
    const updated = await eb.webhooks.update(endpoint.endpointId, {
      active: false,
    });
    const rotated = await eb.webhooks.rotateSecret(endpoint.endpointId);
    const deliveries = await eb.webhooks.deliveries(endpoint.endpointId, {
      limit: 10,
    });
    await eb.webhooks.delete(endpoint.endpointId);

    expect(created.secret).toBe("whsec_sdk_secret");
    expect(page.nextCursor).toBe("next_sdk");
    expect(updated.active).toBe(false);
    expect(rotated.secret).toBe("whsec_rotated_secret");
    expect(deliveries.deliveries[0]?.deliveryId).toBe("whd_sdk");
    expect(new URL(requests[1]?.url ?? "").search).toBe(
      "?cursor=cursor_sdk&limit=25",
    );
    expect(requests.map(({ method }) => method)).toEqual([
      "POST",
      "GET",
      "PATCH",
      "POST",
      "GET",
      "DELETE",
    ]);
    await expect(requests[2]?.json()).resolves.toEqual({ active: false });
  });

  it("refuses tool names that were not present in the emitted bundle", async () => {
    const run = vi.fn(async () => ({ refunded: true }));
    const eb = { tools: { run } } as unknown as Eyeball;

    const [result] = await executeToolCalls(
      eb,
      [
        {
          type: "tool_use",
          id: "toolu_injected",
          name: "stripe__create_refund",
          input: { paymentId: "pay_1" },
        },
      ],
      { nameMap },
    );

    expect(result).toMatchObject({
      is_error: true,
      content: expect.stringContaining("not_supported"),
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts OpenAI's current custom-call union and returns a typed error", async () => {
    const run = vi.fn();
    const eb = { tools: { run } } as unknown as Eyeball;

    const [result] = await executeToolCalls(
      eb,
      [
        {
          id: "custom-1",
          type: "custom",
          custom: { name: "shell", input: "pwd" },
        },
      ],
      { nameMap },
    );

    expect(result).toMatchObject({
      role: "tool",
      tool_call_id: "custom-1",
      content: expect.stringContaining("not_supported"),
    });
    expect(run).not.toHaveBeenCalled();
  });
});
