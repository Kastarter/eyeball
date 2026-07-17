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
});
