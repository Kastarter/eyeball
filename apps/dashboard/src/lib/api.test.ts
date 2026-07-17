import { describe, expect, it } from "vitest";
import { ExecutorApiError, ExecutorClient } from "./api";

describe("ExecutorClient", () => {
  it("reads the executor's public health response", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ service: "executor", status: "ok" });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example/",
      fetch,
    });

    await expect(client.health()).resolves.toEqual({
      service: "executor",
      status: "ok",
    });
    expect(request?.url).toBe("https://executor.example/health");
    expect(request?.headers.get("Accept")).toBe("application/json");
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  it("serializes authenticated execution-list filters onto the wire API", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ executions: [] });
    };
    const client = new ExecutorClient({
      apiKey: "eyeball_test_key",
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(
      client.listExecutions({
        cursor: "cursor_2",
        limit: 25,
        status: "running",
        tool: "gmail.send_email",
        userId: "user_123",
      }),
    ).resolves.toEqual({ executions: [] });

    expect(request?.url).toBe(
      "https://executor.example/v1/executions?cursor=cursor_2&limit=25&status=running&tool=gmail.send_email&userId=user_123",
    );
    expect(request?.headers.get("Authorization")).toBe(
      "Bearer eyeball_test_key",
    );
  });

  it("rejects malformed health envelopes without treating them as online", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({ service: "unknown", status: "ok" });
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ExecutorApiError);
  });

  it("lists, creates, and revokes dev-vault connections", async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return Response.json(
          {
            connectionId: "conn_123",
            redirectUrl: null,
            status: "connected",
          },
          { status: 201 },
        );
      }
      if (request.method === "DELETE") {
        return Response.json({ connectionId: "conn_123", status: "revoked" });
      }
      return Response.json({
        connections: [
          {
            connectionId: "conn_123",
            createdAt: "2026-07-17T09:30:00.000Z",
            status: "connected",
            toolkit: "gmail",
            userId: "user_123",
          },
        ],
      });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.listConnections()).resolves.toMatchObject({
      connections: [{ connectionId: "conn_123" }],
    });
    await expect(
      client.createConnection({ toolkit: "gmail", userId: "user_123" }),
    ).resolves.toMatchObject({ connectionId: "conn_123" });
    await expect(client.revokeConnection("conn_123")).resolves.toEqual({
      connectionId: "conn_123",
      status: "revoked",
    });

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "https://executor.example/v1/connections" },
      { method: "POST", url: "https://executor.example/v1/connections" },
      {
        method: "DELETE",
        url: "https://executor.example/v1/connections/conn_123",
      },
    ]);
    await expect(requests[1]?.json()).resolves.toEqual({
      toolkit: "gmail",
      userId: "user_123",
    });
  });

  it("posts try-it executions and preserves normalized error taxonomy", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json(
        {
          error: {
            code: "auth_missing",
            message: "Connect this user first.",
            retryable: false,
          },
          requestId: "req_try_it",
        },
        { status: 422 },
      );
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(
      client.execute({
        input: { query: "invoice" },
        mode: "sync",
        tool: "gmail.search_emails",
        userId: "user_123",
      }),
    ).rejects.toMatchObject({
      code: "auth_missing",
      message: "Connect this user first.",
      requestId: "req_try_it",
      retryable: false,
      status: 422,
    });
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    await expect(request?.json()).resolves.toMatchObject({
      tool: "gmail.search_emails",
      userId: "user_123",
    });
  });
});
