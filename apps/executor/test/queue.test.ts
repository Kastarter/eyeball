import { describe, expect, it, vi } from "vitest";
import { PromiseTaskQueue } from "../src/index.js";

describe("PromiseTaskQueue", () => {
  it("releases a worker slot when a task throws before returning a promise", async () => {
    const queue = new PromiseTaskQueue(1);
    const second = vi.fn(async () => undefined);
    const firstPromise = queue.enqueue((() => {
      throw new Error("synchronous task failure");
    }) as () => Promise<void>);
    const secondPromise = queue.enqueue(second);

    await expect(firstPromise).rejects.toThrow("synchronous task failure");
    await expect(secondPromise).resolves.toBeUndefined();
    await expect(queue.onIdle()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
  });
});
