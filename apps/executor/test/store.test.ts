import {
  createExecutionId,
  type ExecuteRequest,
  type ExecutionId,
  type ExecutionRecord,
} from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  type ExecutionAllocation,
  InMemoryExecutionStore,
} from "../src/index.js";

const PROJECT_ID = "project_store";
const CREATED_AT = "2026-07-17T00:00:00.000Z";

function allocation(
  executionId: ExecutionId,
  key: string,
  requestHash = `hash:${key}`,
): ExecutionAllocation {
  const request: ExecuteRequest = {
    tool: "gmail.send_email",
    userId: "user_store",
    input: { to: ["buyer@example.com"], subject: key, body: "Hello" },
    mode: "sync",
  };
  const record: ExecutionRecord & { status: "pending" } = {
    executionId,
    tool: request.tool,
    toolVersion: "1.0.0",
    catalogVersion: "1.1",
    userId: request.userId,
    status: "pending",
    createdAt: CREATED_AT,
  };
  return {
    projectId: PROJECT_ID,
    request,
    record,
    idempotency: {
      scope: {
        key,
        tool: request.tool,
        userId: request.userId,
        connectionId: "default",
        catalogMajor: "1",
      },
      requestHash,
      expiresAt: "2026-07-18T00:00:00.000Z",
    },
  };
}

describe("InMemoryExecutionStore", () => {
  it("does not commit idempotency indexes when an execution ID is duplicate", async () => {
    const store = new InMemoryExecutionStore();
    const existingId = createExecutionId("existing");
    await expect(
      store.allocate(allocation(existingId, "key-a")),
    ).resolves.toMatchObject({
      kind: "allocated",
    });

    await expect(
      store.allocate(allocation(existingId, "key-b")),
    ).rejects.toThrow("Duplicate execution ID");

    const retryId = createExecutionId("retry");
    await expect(
      store.allocate(allocation(retryId, "key-b")),
    ).resolves.toMatchObject({
      kind: "allocated",
      record: { executionId: retryId },
    });
  });

  it("paginates from a stable execution anchor when newer rows arrive", async () => {
    const store = new InMemoryExecutionStore();
    const oldestId = createExecutionId("oldest");
    const firstPageId = createExecutionId("first_page");
    const insertedId = createExecutionId("inserted");
    await store.allocate(allocation(oldestId, "oldest"));
    await store.allocate(allocation(firstPageId, "first-page"));

    const first = await store.list(PROJECT_ID, { limit: 1 });
    expect(first.executions.map(({ executionId }) => executionId)).toEqual([
      firstPageId,
    ]);
    expect(first.nextCursor).toBeDefined();

    await store.allocate(allocation(insertedId, "inserted"));
    const second = await store.list(PROJECT_ID, {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.executions.map(({ executionId }) => executionId)).toEqual([
      oldestId,
    ]);
  });
});
