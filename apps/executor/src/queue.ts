export interface TaskQueue {
  enqueue(task: () => Promise<void>): Promise<void>;
  onIdle(): Promise<void>;
}

interface QueuedTask {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class PromiseTaskQueue implements TaskQueue {
  readonly #concurrency: number;
  readonly #pending: QueuedTask[] = [];
  readonly #idleWaiters = new Set<() => void>();
  #active = 0;
  #scheduled = false;

  constructor(concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(
        "Task queue concurrency must be a positive integer.",
      );
    }
    this.#concurrency = concurrency;
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      this.#pending.push({ task, resolve, reject });
    });
    this.#schedule();
    return result;
  }

  onIdle(): Promise<void> {
    if (this.#active === 0 && this.#pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #schedule(): void {
    if (this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#concurrency) {
      const queued = this.#pending.shift();
      if (queued === undefined) {
        break;
      }

      this.#active += 1;
      void queued
        .task()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.#active -= 1;
          this.#drain();
          this.#resolveIdle();
        });
    }
    this.#resolveIdle();
  }

  #resolveIdle(): void {
    if (this.#active !== 0 || this.#pending.length !== 0) {
      return;
    }
    for (const resolve of this.#idleWaiters) {
      resolve();
    }
    this.#idleWaiters.clear();
  }
}
