import { describe, expect, it, vi } from "vitest";
import { InMemoryTaskQueue, type JobHandlerRegistry } from "../src/index.js";

function job(id: string) {
  return {
    kind: "execution.run.v1" as const,
    payload: { projectId: "project_queue", executionId: id },
  };
}

describe("InMemoryTaskQueue", () => {
  it("releases a worker slot when a handler throws synchronously", async () => {
    const queue = new InMemoryTaskQueue({ executionConcurrency: 1 });
    const second = vi.fn(async () => ({ type: "complete" as const }));
    const handlers: JobHandlerRegistry = {
      "execution.run.v1": (payload) => {
        if (payload.executionId === "exe_first") {
          throw new Error("synchronous task failure");
        }
        return second();
      },
      "webhook.select.v1": async () => ({ type: "complete" }),
      "webhook.deliver.v1": async () => ({ type: "complete" }),
    };
    queue.bindHandlers(handlers);
    queue.start();

    const first = queue.enqueue(job("exe_first"));
    const next = queue.enqueue(job("exe_second"));
    await expect(first).rejects.toMatchObject({ code: "handler_rejected" });
    await expect(next).resolves.toBeUndefined();
    await expect(queue.onIdle()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
  });
});
