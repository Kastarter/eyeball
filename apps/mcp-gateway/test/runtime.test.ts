import { describe, expect, it, vi } from "vitest";
import {
  createMcpGatewayRuntime,
  InMemorySessionStore,
  type McpGatewayPersistence,
} from "../src/index.js";

function persistence(): McpGatewayPersistence & {
  close: ReturnType<typeof vi.fn>;
} {
  return {
    sessionStore: new InMemorySessionStore(),
    close: vi.fn(async () => undefined),
  };
}

describe("MCP gateway runtime composition", () => {
  it("uses an in-memory session store without a database variable", async () => {
    const runtime = await createMcpGatewayRuntime({ env: {} });
    expect(runtime.sessionStore).toBeInstanceOf(InMemorySessionStore);
    expect(runtime.persistence).toBeUndefined();
    await runtime.close();
  });

  it("opens the durable factory for a nonblank database variable", async () => {
    const bundle = persistence();
    const factory = vi.fn(async () => bundle);
    const runtime = await createMcpGatewayRuntime({
      env: { EYEBALL_DATABASE_URL: "  postgresql://db.example/eyeball  " },
      persistenceFactory: factory,
    });
    expect(factory).toHaveBeenCalledWith("postgresql://db.example/eyeball");
    expect(runtime.sessionStore).toBe(bundle.sessionStore);
    expect(runtime.persistence).toBe(bundle);
    await runtime.close();
  });

  it("gives an explicitly injected store precedence over database setup", async () => {
    const store = new InMemorySessionStore();
    const factory = vi.fn(async () => persistence());
    const runtime = await createMcpGatewayRuntime({
      env: { EYEBALL_DATABASE_URL: "postgresql://unused.example/eyeball" },
      sessionStore: store,
      persistenceFactory: factory,
    });
    expect(runtime.sessionStore).toBe(store);
    expect(runtime.persistence).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("closes initialized persistence when app construction fails", async () => {
    const bundle = persistence();
    await expect(
      createMcpGatewayRuntime({
        env: { EYEBALL_DATABASE_URL: "postgresql://db.example/eyeball" },
        executorApiKey: "downstream-only",
        persistenceFactory: async () => bundle,
      }),
    ).rejects.toThrow(
      "EYEBALL_EXECUTOR_API_KEY requires an inbound EYEBALL_API_KEYS policy.",
    );
    expect(bundle.close).toHaveBeenCalledTimes(1);
  });

  it("closes persistence at most once", async () => {
    const bundle = persistence();
    const runtime = await createMcpGatewayRuntime({
      env: { EYEBALL_DATABASE_URL: "postgresql://db.example/eyeball" },
      persistenceFactory: async () => bundle,
    });
    await runtime.close();
    await runtime.close();
    expect(bundle.close).toHaveBeenCalledTimes(1);
  });

  it("does not construct a ready runtime when migration setup rejects", async () => {
    const migrationError = new Error("migration failed");
    const factory = vi.fn(async () => {
      throw migrationError;
    });
    await expect(
      createMcpGatewayRuntime({
        env: { EYEBALL_DATABASE_URL: "postgresql://db.example/eyeball" },
        persistenceFactory: factory,
      }),
    ).rejects.toBe(migrationError);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
