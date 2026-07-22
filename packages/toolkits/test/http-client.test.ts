import {
  type AdapterContext,
  type EyeballError,
  noopLogger,
  TOOL_ERROR_CODES,
  type ToolDefinition,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
import { createProviderHttpClient } from "../src/http-client.js";

function context(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): AdapterContext {
  const tool: ToolDefinition = {
    name: "gmail.search_emails",
    toolkit: "gmail",
    capability: "email",
    description: "HTTP cancellation fixture.",
    inputSchema: { type: "object" },
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      async: false,
    },
    version: "1.0.0",
  };
  return {
    projectId: "project_http_cancel",
    userId: "user_http_cancel",
    tool,
    canonicalInput: { query: "cancel me" },
    credential: {
      type: "oauth2",
      accessToken: "fixture-token",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    },
    baseUrl: "https://provider.example.test/v1",
    fetchImpl,
    clock: { now: () => new Date("2026-07-18T00:00:00.000Z") },
    logger: noopLogger,
    ...(signal === undefined ? {} : { signal }),
    files: {
      resolve: async () => {
        throw new Error("No files expected in HTTP cancellation tests.");
      },
    },
  };
}

function abortableFetch(signals: AbortSignal[]): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) {
      throw new Error("Provider request omitted its cancellation signal.");
    }
    signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  }) as typeof fetch;
}

describe("provider HTTP cancellation", () => {
  it("passes the execution cancellation signal through to fetch", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const request = createProviderHttpClient(
      context(abortableFetch(signals), controller.signal),
    )("messages");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.TIMEOUT,
    } satisfies Partial<EyeballError>);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("combines execution cancellation with a request-local signal", async () => {
    const executionController = new AbortController();
    const requestController = new AbortController();
    const signals: AbortSignal[] = [];
    const request = createProviderHttpClient(
      context(abortableFetch(signals), executionController.signal),
    )("messages", { signal: requestController.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]).not.toBe(executionController.signal);
    expect(signals[0]).not.toBe(requestController.signal);
    requestController.abort();
    await expect(request).rejects.toMatchObject({
      code: TOOL_ERROR_CODES.TIMEOUT,
    } satisfies Partial<EyeballError>);
    expect(signals[0]?.aborted).toBe(true);
    expect(executionController.signal.aborted).toBe(false);
  });
});
