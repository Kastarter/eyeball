import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createMcpGatewayRuntime } from "../src/index.js";

it("preserves the PR1 legacy wire contract", async () => {
  const runtime = await createMcpGatewayRuntime({
    env: {},
    apiKey: "legacy_wire",
    userId: "legacy_user",
    sessionIdFactory: () => "legacy_session",
    executor: {
      execute: async () => ({
        executionId: "exe_legacy",
        tool: "gmail.list_emails",
        toolVersion: "1.0.0",
        catalogVersion: "1.1",
        status: "succeeded",
        output: { emails: [] },
        latencyMs: 1,
      }),
    },
  });
  const results = [];
  const post = async (method: string, params: unknown, session?: string) => {
    const response = await runtime.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer legacy_wire",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();
    // Hash the complete catalog rather than checking in 58,000 snapshot lines.
    if (body.result?.tools)
      body.result.tools = {
        count: body.result.tools.length,
        sha256: createHash("sha256")
          .update(JSON.stringify(body.result.tools))
          .digest("hex"),
      };
    results.push({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
    });
  };
  try {
    await post("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy", version: "1" },
    });
    await post("tools/list", {}, "legacy_session");
    await post(
      "tools/call",
      { name: "gmail.list_emails", arguments: {} },
      "legacy_session",
    );
    await post("tools/list", {}, "invalid");
    await post("tools/call", { name: "gmail.list_emails", arguments: {} });
    const missing = await runtime.app.request("/mcp", {
      method: "DELETE",
      headers: { Authorization: "Bearer legacy_wire" },
    });
    results.push({
      status: missing.status,
      headers: Object.fromEntries(missing.headers),
      body: await missing.json(),
    });
    expect(results).toMatchSnapshot();
  } finally {
    await runtime.close();
  }
});
