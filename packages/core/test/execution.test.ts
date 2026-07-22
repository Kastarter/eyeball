import { describe, expect, it } from "vitest";
import {
  type CancelledExecutionRecord,
  createConnectionId,
  createExecutionId,
  createFileId,
  type ExecutionResult,
  isConnectionId,
  isExecutionId,
  isFileId,
  type TerminalExecutionRecord,
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

describe("cancelled execution contracts", () => {
  const cancelled = {
    executionId: createExecutionId("cancelled_contract"),
    tool: "gmail.send_email",
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    userId: "user_contract",
    createdAt: "2026-07-21T12:00:00.000Z",
    completedAt: "2026-07-21T12:00:00.010Z",
    latencyMs: 10,
    status: "cancelled",
    error: {
      code: "execution_cancelled",
      message: "Execution was cancelled before provider dispatch.",
      retryable: false,
    },
    cancellation: { dispatchMayHaveBegun: false },
  } as const satisfies CancelledExecutionRecord;

  it("discriminates cancelled immediate and terminal results with disposition metadata", () => {
    const immediate: ExecutionResult = cancelled;
    const terminal: TerminalExecutionRecord = cancelled;

    expect(immediate.status).toBe("cancelled");
    expect(terminal.status).toBe("cancelled");
    if (terminal.status === "cancelled") {
      expect(terminal.error).toMatchObject({
        code: "execution_cancelled",
        retryable: false,
      });
      expect(terminal.cancellation.dispatchMayHaveBegun).toBe(false);
    }
  });
});
