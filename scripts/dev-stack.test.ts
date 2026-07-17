import { describe, expect, it } from "vitest";
import { createInProcessDevStack } from "./dev-stack.js";

describe("full development stack", () => {
  it("runs Mockhouse, executor, and MCP gateway as one composition", async () => {
    const stack = await createInProcessDevStack();
    const authorization = { Authorization: `Bearer ${stack.apiKey}` };

    const executorHealth = await stack.executorApp.request("/health");
    expect(executorHealth.status).toBe(200);
    await expect(executorHealth.json()).resolves.toEqual({
      status: "ok",
      service: "executor",
    });

    const gatewayHealth = await stack.mcpGatewayApp.request("/health");
    expect(gatewayHealth.status).toBe(200);
    await expect(gatewayHealth.json()).resolves.toEqual({
      status: "ok",
      service: "mcp-gateway",
    });

    const mockStatus = await stack.mockhouseApp.request("/_mock/status");
    const statusBody = (await mockStatus.json()) as { providers: string[] };
    expect(mockStatus.status).toBe(200);
    expect(statusBody.providers).toHaveLength(30);
    expect(statusBody.providers).toContain("gmail");

    const execution = await stack.executorApp.request("/v1/execute", {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": "dev-stack:gmail:send-email",
      },
      body: JSON.stringify({
        tool: "gmail.send_email",
        userId: stack.userId,
        input: {
          to: ["founder@example.com"],
          subject: "Eyeball dev stack",
          body: "Mockhouse, executor, and MCP are running together.",
        },
        mode: "sync",
      }),
    });
    const executionBody = (await execution.json()) as {
      status?: string;
      output?: { messageId?: string };
    };
    expect(execution.status).toBe(200);
    expect(executionBody).toMatchObject({
      status: "succeeded",
      output: { messageId: expect.stringMatching(/^gmail_msg_/) },
    });

    const listed = await stack.mcpGatewayApp.request("/mcp", {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "dev-stack-tools-list",
        method: "tools/list",
        params: {},
      }),
    });
    const listedBody = (await listed.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    expect(listed.status).toBe(200);
    expect(listedBody.result?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "gmail.send_email" }),
      ]),
    );
  });
});
