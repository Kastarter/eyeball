import {
  type CredentialContext,
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
import { createMcpGatewayRuntime } from "../src/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(pauseAlice = false) {
  const entered = deferred(),
    resume = deferred();
  const events: string[] = [];
  const credentials = new MockCredentialProvider(
    ["Alpha", "Beta"].map((projectId, index) => ({
      match: {
        projectId,
        userId: index === 0 ? "Alice" : "Bob",
        toolkitSlug: "gmail",
      },
      credential: {
        type: "oauth2" as const,
        accessToken: index === 0 ? "fixture:Cred-A" : "fixture:Cred-B",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
    })),
  );
  const resolve = vi.fn(async (context: CredentialContext) => {
    events.push(`resolve:${context.projectId}:${context.userId}`);
    if (pauseAlice && context.userId === "Alice") {
      entered.resolve();
      await resume.promise;
    }
    return credentials.resolve(context);
  });
  const execute = vi.fn<ToolkitAdapter["execute"]>(async (context) => {
    const { projectId, userId, canonicalInput } = context;
    events.push(`execute:${projectId}:${userId}`);
    return {
      messageId: `msg_${projectId}_${userId}`,
      acceptedRecipients: canonicalInput.to,
    };
  });
  let allocation = 0;
  const engine = new ExecutionEngine({
    adapters: new AdapterRegistry([{ toolkitSlug: "gmail", execute }]),
    credentialProvider: { kind: "mock", resolve },
    executionIdFactory: () => createExecutionId(`isolation_${++allocation}`),
  });
  const apiKeys = {
    alpha_key: { projectId: "Alpha", userId: "Alice" },
    beta_key: { projectId: "Beta", userId: "Bob" },
  };
  const executorApp = createExecutorApp({ engine, apiKeys });
  const fetchImpl = vi.fn((async (input, init) =>
    executorApp.request(new Request(input, init))) as typeof fetch);
  const runtime = await createMcpGatewayRuntime({
    env: {},
    apiKeys,
    fetchImpl,
    executorBaseUrl: "https://executor.local.test",
  });
  const call = (
    key: string,
    id: string,
    headerName = "gmail.send_email",
    extraMeta: Record<string, unknown> = {},
  ) =>
    runtime.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": headerName,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "gmail.send_email",
          arguments: {
            to: ["local@example.test"],
            subject: "Local isolation test",
            body: "No network provider",
          },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            // Deliberately claims the OTHER principal and credential. It is never authority.
            "io.modelcontextprotocol/clientInfo": {
              name: key === "alpha_key" ? "Bob" : "Alice",
              version: "1",
              projectId: key === "alpha_key" ? "Beta" : "Alpha",
              accessToken: key === "alpha_key" ? "Cred-B" : "Cred-A",
            },
            "dev.eyeball/idempotencyKey": "same-operation-across-principals",
            ...extraMeta,
          },
        },
      }),
    });
  return {
    runtime,
    engine,
    entered,
    resume,
    events,
    resolve,
    execute,
    fetchImpl,
    call,
    allocations: () => allocation,
  };
}

describe("stateless authenticated executor isolation", () => {
  it("keeps Alpha/Alice and Beta/Bob isolated across a deterministic credential barrier", async () => {
    const f = await fixture(true);
    const a = f.call("alpha_key", "A");
    try {
      await f.entered.promise;
      const b = await f.call("beta_key", "B");
      expect(b.status).toBe(200);
      const bodyB = await b.json();
      expect(bodyB.result.structuredContent.messageId).toBe("msg_Beta_Bob");
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.events).toEqual([
        "resolve:Alpha:Alice",
        "resolve:Beta:Bob",
        "execute:Beta:Bob",
      ]);
      f.resume.resolve();
      const bodyA = await (await a).json();
      expect(bodyA.result.structuredContent.messageId).toBe("msg_Alpha_Alice");
      expect(f.events).toEqual([
        "resolve:Alpha:Alice",
        "resolve:Beta:Bob",
        "execute:Beta:Bob",
        "execute:Alpha:Alice",
      ]);
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(
        f.execute.mock.calls.map(([context]) => ({
          projectId: context.projectId,
          userId: context.userId,
          credential: context.credential,
        })),
      ).toEqual([
        {
          projectId: "Beta",
          userId: "Bob",
          credential: expect.objectContaining({
            type: "oauth2",
            accessToken: "fixture:Cred-B",
          }),
        },
        {
          projectId: "Alpha",
          userId: "Alice",
          credential: expect.objectContaining({
            type: "oauth2",
            accessToken: "fixture:Cred-A",
          }),
        },
      ]);
      const idA = bodyA.result._meta["dev.eyeball/execution"].executionId;
      const idB = bodyB.result._meta["dev.eyeball/execution"].executionId;
      expect(idA).not.toBe(idB);
      expect(await f.engine.getExecution("Alpha", idA)).toMatchObject({
        userId: "Alice",
        output: { messageId: "msg_Alpha_Alice" },
      });
      expect(await f.engine.getExecution("Beta", idB)).toMatchObject({
        userId: "Bob",
        output: { messageId: "msg_Beta_Bob" },
      });
      await expect(f.engine.getExecution("Beta", idA)).rejects.toThrow(
        "Execution was not found.",
      );
      await expect(f.engine.getExecution("Alpha", idB)).rejects.toThrow(
        "Execution was not found.",
      );
    } finally {
      f.resume.resolve();
      await a;
      await f.runtime.close();
    }
  });

  it("preserves one provider effect for a fresh HTTP retry with the existing idempotency identity", async () => {
    const f = await fixture();
    try {
      const first = await (await f.call("alpha_key", "lost-response")).json();
      const retry = await (await f.call("alpha_key", "fresh-request")).json();
      expect(retry.result).toEqual(first.result);
      // Candidate IDs can be generated on retries; only one is persisted.
      expect(
        await f.engine.store.get("Alpha", "exe_isolation_1"),
      ).toBeDefined();
      expect(
        await f.engine.store.get("Alpha", "exe_isolation_2"),
      ).toBeUndefined();
      expect(f.execute).toHaveBeenCalledOnce();
      expect(f.resolve).toHaveBeenCalledOnce();
    } finally {
      await f.runtime.close();
    }
  });

  it("rejects header/body confusion before credential resolution, allocation, or provider effects", async () => {
    const f = await fixture();
    try {
      const response = await f.call("alpha_key", "bad", "gmail.list_emails");
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32020 } });
      expect(f.fetchImpl).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.allocations()).toBe(0);
    } finally {
      await f.runtime.close();
    }
  });

  it("does not let vendor user metadata override a pinned authenticated user", async () => {
    const f = await fixture();
    try {
      const response = await f.call("alpha_key", "spoof", "gmail.send_email", {
        "dev.eyeball/userId": "Bob",
      });
      expect(await response.json()).toMatchObject({
        result: { isError: true },
      });
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      await f.runtime.close();
    }
  });
});
