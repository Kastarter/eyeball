import {
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
import { createMcpGatewayApp } from "../src/index.js";

const API_KEY = "ey_test_mcp_e2e";
const PROJECT_ID = "proj_mcp_e2e";
const USER_ID = "user_mcp_e2e";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

describe("MCP gateway to executor", () => {
  it("replays one mutating MCP call as one executor allocation", async () => {
    const execute = vi.fn(async ({ canonicalInput }) => ({
      messageId: "msg_mcp_e2e",
      acceptedRecipients: canonicalInput.to,
    }));
    const adapter: ToolkitAdapter = {
      toolkitSlug: "gmail",
      execute,
    };
    const engine = new ExecutionEngine({
      adapters: new AdapterRegistry([adapter]),
      credentialProvider: new MockCredentialProvider([
        {
          match: {
            projectId: PROJECT_ID,
            userId: USER_ID,
            toolkitSlug: "gmail",
          },
          credential: {
            type: "oauth2",
            accessToken: "fixture:mcp-e2e",
            scopes: [GMAIL_SCOPE],
          },
        },
      ]),
      executionIdFactory: () => createExecutionId("mcp_e2e"),
    });
    const executorApp = createExecutorApp({
      engine,
      apiKeys: { [API_KEY]: PROJECT_ID },
      requestIdFactory: () => "req_mcp_e2e",
    });
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => executorApp.request(new Request(input, init))) as typeof fetch;
    const gateway = createMcpGatewayApp({
      executorBaseUrl: "http://executor.mcp.test",
      fetchImpl,
      apiKey: API_KEY,
      userId: USER_ID,
    });
    const call = {
      jsonrpc: "2.0",
      id: "tool-call-19",
      method: "tools/call",
      params: {
        name: "gmail.send_email",
        arguments: {
          to: ["recipient@example.com"],
          subject: "MCP delivery",
          body: "One logical call should allocate once.",
        },
      },
    };
    const headers = {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": "mcp_e2e_session",
    };

    const first = await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(call),
    });
    const replay = await gateway.request("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(call),
    });
    const firstBody = (await first.json()) as {
      result: {
        structuredContent: unknown;
        _meta: { "dev.eyeball/execution": { executionId: string } };
      };
    };
    const replayBody = (await replay.json()) as typeof firstBody;

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(firstBody.result.structuredContent).toEqual({
      messageId: "msg_mcp_e2e",
      acceptedRecipients: ["recipient@example.com"],
    });
    expect(replayBody.result).toEqual(firstBody.result);
    expect(firstBody.result._meta["dev.eyeball/execution"].executionId).toBe(
      "exe_mcp_e2e",
    );
    expect(execute).toHaveBeenCalledTimes(1);

    const stored = await engine.getExecution(PROJECT_ID, "exe_mcp_e2e");
    expect(stored).toMatchObject({
      status: "succeeded",
      tool: "gmail.send_email",
      userId: USER_ID,
      output: {
        messageId: "msg_mcp_e2e",
        acceptedRecipients: ["recipient@example.com"],
      },
    });
  });
});
