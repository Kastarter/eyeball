import { defaultCatalog } from "@eyeball/catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMcpGatewayRuntime,
  InMemorySessionStore,
  type McpGatewayRuntime,
} from "../src/index.js";

const version = "2026-07-28";
const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const runtimes: McpGatewayRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

function envelope(method = "tools/call") {
  return {
    jsonrpc: "2.0",
    id: "modern",
    method,
    params: {
      ...(method === "tools/call"
        ? { name: "gmail.list_emails", arguments: {} }
        : {}),
      _meta: { [versionKey]: version, [capabilitiesKey]: {} } as Record<
        string,
        unknown
      >,
    },
  };
}
function headers(method = "tools/call") {
  return new Headers({
    Authorization: "Bearer boundary_key",
    "Content-Type": "application/json",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(method === "tools/call" ? { "Mcp-Name": "gmail.list_emails" } : {}),
  });
}
async function fixture() {
  const store = new InMemorySessionStore();
  const reads = vi.spyOn(store, "get"),
    writes = vi.spyOn(store, "set"),
    updates = vi.spyOn(store, "update");
  const execute = vi.fn(async () => ({
    executionId: "exe_boundary" as const,
    tool: "gmail.list_emails" as const,
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    status: "succeeded" as const,
    output: { emails: [] },
    latencyMs: 1,
  }));
  const resolve = vi.fn((name: string) => defaultCatalog.getTool(name));
  const runtime = await createMcpGatewayRuntime({
    env: {},
    apiKey: "boundary_key",
    userId: "boundary_user",
    executor: { execute },
    sessionStore: store,
    catalog: { listTools: () => defaultCatalog.listTools(), getTool: resolve },
  });
  runtimes.push(runtime);
  return { ...runtime, reads, writes, updates, execute, resolve };
}

describe("modern request boundary", () => {
  it.each([
    [capabilitiesKey, []],
    [capabilitiesKey, null],
    [capabilitiesKey, "all"],
    [versionKey, 2026],
    ["io.modelcontextprotocol/clientInfo", { name: "invalid" }],
  ] as const)("rejects malformed metadata %s=%j", async (key, value) => {
    const f = await fixture();
    const body = envelope();
    body.params._meta[key] = value;
    const response = await f.app.request("/mcp", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("requires unsafe Mcp-Name values to use UTF-8 Base64 encoding", async () => {
    const f = await fixture();
    const body = envelope();
    body.params.name = "café";
    const h = headers();
    h.set("Mcp-Name", "café");
    const invalid = await f.app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: -32020 } });
    expect(f.resolve).not.toHaveBeenCalled();
    // UTF-8 decoding must not discard a leading BOM and make unequal names match.
    h.set(
      "Mcp-Name",
      `=?base64?${Buffer.from("\uFEFFcafé").toString("base64")}?=`,
    );
    const bom = await f.app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    expect(bom.status).toBe(400);
    expect(await bom.json()).toMatchObject({ error: { code: -32020 } });
    expect(f.resolve).not.toHaveBeenCalled();
    h.set("Mcp-Name", `=?base64?${Buffer.from("café").toString("base64")}?=`);
    const encoded = await f.app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    });
    expect(encoded.status).toBe(200); // Unknown tool is handled by the existing resolver.
    expect(f.resolve).toHaveBeenCalledWith("café");
  });

  it.each([
    "server/discover",
    "tools/list",
    "tools/call",
  ])("%s has zero session access with absent, invalid, or valid session headers in JSON and SSE", async (method) => {
    const f = await fixture();
    const initialized = await f.app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer boundary_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: { tasks: {} },
          clientInfo: { name: "legacy", version: "1" },
        },
      }),
    });
    const valid = initialized.headers.get("Mcp-Session-Id") ?? "";
    expect(valid).not.toBe("");
    f.reads.mockClear();
    f.writes.mockClear();
    f.updates.mockClear();
    for (const session of [undefined, "unknown", valid])
      for (const sse of [false, true]) {
        const h = headers(method);
        if (session) h.set("Mcp-Session-Id", session);
        if (sse) h.set("Accept", "application/json, text/event-stream");
        const response = await f.app.request("/mcp", {
          method: "POST",
          headers: h,
          body: JSON.stringify(envelope(method)),
        });
        expect(response.status).toBe(200);
        expect(response.headers.has("Mcp-Session-Id")).toBe(false);
        const raw = await response.text();
        const body = JSON.parse(
          sse
            ? (raw
                .split("\n")
                .filter(
                  (line) => line.startsWith("data:") && line.slice(5).trim(),
                )
                .at(-1)
                ?.slice(5) ?? "")
            : raw,
        );
        expect(body.result.resultType).toBe("complete");
        if (method === "tools/list")
          expect(body.result).toMatchObject({
            ttlMs: 0,
            cacheScope: "private",
          });
        if (method === "tools/call")
          expect(body.result).toMatchObject({
            structuredContent: { emails: [] },
          });
      }
    expect(f.reads).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
    expect(f.updates).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(method === "tools/call" ? 6 : 0);
  });

  it.each([
    ["Mcp-Method", "tools/list"],
    ["Mcp-Name", "gmail.send_email"],
    ["MCP-Protocol-Version", "2025-11-25"],
    ["Mcp-Method", null],
    ["Mcp-Name", null],
    ["MCP-Protocol-Version", null],
    ["Mcp-Name", "=?base64?%%%?="],
    ["Mcp-Name", "=?base64?/w==?="],
    ["Mcp-Method", "Tools/Call"],
  ] as const)("rejects %s=%s before catalog resolution or executor access", async (header, value) => {
    const f = await fixture();
    const h = headers();
    if (value === null) h.delete(header);
    else h.set(header, value);
    const response = await f.app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(envelope()),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      id: "modern",
      error: { code: -32020 },
    });
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.reads).not.toHaveBeenCalled();
  });

  it.each([
    versionKey,
    capabilitiesKey,
  ])("rejects missing %s independently on every request", async (key) => {
    const f = await fixture();
    await f.app.request("/mcp", {
      method: "POST",
      headers: headers("tools/list"),
      body: JSON.stringify(envelope("tools/list")),
    });
    const body = envelope();
    delete body.params._meta[key];
    const response = await f.app.request("/mcp", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("decodes Mcp-Name and handles field names case-insensitively", async () => {
    const f = await fixture();
    const h = headers();
    h.set(
      "mcp-name",
      `=?base64?${Buffer.from("gmail.list_emails").toString("base64")}?=`,
    );
    const response = await f.app.request("/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(envelope()),
    });
    expect(response.status).toBe(200);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("executes the second request on a fresh gateway without initialization or list state", async () => {
    const first = await fixture();
    await first.app.request("/mcp", {
      method: "POST",
      headers: headers("tools/list"),
      body: JSON.stringify(envelope("tools/list")),
    });
    await first.close();
    const second = await fixture();
    const response = await second.app.request("/mcp", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(envelope()),
    });
    expect(await response.json()).toMatchObject({
      result: { structuredContent: { emails: [] } },
    });
    expect(second.reads).not.toHaveBeenCalled();
    expect(second.writes).not.toHaveBeenCalled();
  });
});
