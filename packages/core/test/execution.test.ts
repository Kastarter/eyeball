import { describe, expect, it } from "vitest";
import {
  createConnectionId,
  createExecutionId,
  createFileId,
  isConnectionId,
  isExecutionId,
  isFileId,
} from "../src/index.js";

describe("prefixed IDs", () => {
  it("creates deterministic seeded execution, connection, and staged-file IDs", () => {
    expect(createExecutionId("seed_1")).toBe("exe_seed_1");
    expect(createExecutionId("seed_1")).toBe(createExecutionId("seed_1"));
    expect(createConnectionId("seed_1")).toBe("conn_seed_1");
    expect(createConnectionId("seed_1")).toBe(createConnectionId("seed_1"));
    expect(createFileId("seed_1")).toBe("file_seed_1");
    expect(createFileId("seed_1")).toBe(createFileId("seed_1"));
  });

  it("creates valid random IDs with the required prefixes", () => {
    const executionId = createExecutionId();
    const connectionId = createConnectionId();
    const stagedFileId = createFileId();

    expect(executionId).toMatch(/^exe_/);
    expect(connectionId).toMatch(/^conn_/);
    expect(stagedFileId).toMatch(/^file_/);
    expect(isExecutionId(executionId)).toBe(true);
    expect(isConnectionId(connectionId)).toBe(true);
    expect(isFileId(stagedFileId)).toBe(true);
    expect(isExecutionId(connectionId)).toBe(false);
    expect(isConnectionId(executionId)).toBe(false);
    expect(isFileId(executionId)).toBe(false);
    expect(isExecutionId(stagedFileId)).toBe(false);
  });

  it("rejects empty or unsafe deterministic seeds", () => {
    expect(() => createExecutionId("")).toThrow("ID seed");
    expect(() => createConnectionId("contains spaces")).toThrow("ID seed");
    expect(() => createFileId("contains spaces")).toThrow("ID seed");
  });
});
