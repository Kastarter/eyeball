import { describe, expect, it } from "vitest";
import {
  createConnectionId,
  createExecutionId,
  isConnectionId,
  isExecutionId,
} from "../src/index.js";

describe("prefixed IDs", () => {
  it("creates deterministic seeded execution and connection IDs", () => {
    expect(createExecutionId("seed_1")).toBe("exe_seed_1");
    expect(createExecutionId("seed_1")).toBe(createExecutionId("seed_1"));
    expect(createConnectionId("seed_1")).toBe("conn_seed_1");
    expect(createConnectionId("seed_1")).toBe(createConnectionId("seed_1"));
  });

  it("creates valid random IDs with the required prefixes", () => {
    const executionId = createExecutionId();
    const connectionId = createConnectionId();

    expect(executionId).toMatch(/^exe_/);
    expect(connectionId).toMatch(/^conn_/);
    expect(isExecutionId(executionId)).toBe(true);
    expect(isConnectionId(connectionId)).toBe(true);
    expect(isExecutionId(connectionId)).toBe(false);
    expect(isConnectionId(executionId)).toBe(false);
  });

  it("rejects empty or unsafe deterministic seeds", () => {
    expect(() => createExecutionId("")).toThrow("ID seed");
    expect(() => createConnectionId("contains spaces")).toThrow("ID seed");
  });
});
