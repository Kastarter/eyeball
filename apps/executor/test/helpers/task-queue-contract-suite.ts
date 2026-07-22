import { describe, expect, it, vi } from "vitest";
import {
  createJobEnvelope,
  ExecutorTaskSystem,
  type ExecutorTaskSystemOptions,
  executorJobId,
  type JobHandlerRegistry,
  type JobStore,
  QueueHandoffError,
} from "../../src/index.js";

export interface TaskQueueContractImplementation {
  readonly name: string;
  readonly durable: boolean;
  jobStore(): Promise<JobStore>;
}

let sequence = 0;

function identity(label: string): string {
  sequence += 1;
  return `${label.replaceAll(/[^a-z0-9]/giu, "_")}_${sequence}`;
}

function executionJob(id: string) {
  return {
    kind: "execution.run.v1" as const,
    payload: { projectId: `project_${id}`, executionId: `exe_${id}` },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function queue(
  implementation: TaskQueueContractImplementation,
  handlers: JobHandlerRegistry,
  options: Partial<ExecutorTaskSystemOptions> = {},
): Promise<ExecutorTaskSystem> {
  const taskSystem = new ExecutorTaskSystem({
    jobStore: await implementation.jobStore(),
    durable: implementation.durable,
    manual: true,
    pollMs: 1_000,
    ...options,
  });
  taskSystem.bindHandlers(handlers);
  taskSystem.start();
  return taskSystem;
}

const completingHandlers: JobHandlerRegistry = {
  "execution.run.v1": async () => ({ type: "complete" }),
  "webhook.select.v1": async () => ({ type: "complete" }),
  "webhook.deliver.v1": async () => ({ type: "complete" }),
};

export function registerTaskQueueContractSuite(
  implementations: readonly TaskQueueContractImplementation[],
): void {
  describe.each(
    implementations,
  )("$name task queue contract", (implementation) => {
    it(
      "accepts before completion and preserves enqueue completion semantics",
      async () => {
        const scope = identity(implementation.name);
        const held = deferred();
        const handlers: JobHandlerRegistry = {
          ...completingHandlers,
          "execution.run.v1": async () => {
            await held.promise;
            return { type: "complete" };
          },
        };
        const taskSystem = await queue(implementation, handlers);
        const submission = taskSystem.submit(executionJob(scope));
        await expect(submission.accepted).resolves.toBeUndefined();
        let completed = false;
        void submission.completed.then(() => {
          completed = true;
        });
        await taskSystem.runOnce();
        await Promise.resolve();
        expect(completed).toBe(false);
        held.resolve();
        await taskSystem.drainOwned();
        await expect(submission.completed).resolves.toBeUndefined();
        await expect(taskSystem.onIdle()).resolves.toBeUndefined();
      },
      implementation.durable ? 15_000 : 5_000,
    );

    it("runs four execution jobs and leaves the fifth pending", async () => {
      const scope = identity(implementation.name);
      const held = deferred();
      let active = 0;
      let maximum = 0;
      const handlers: JobHandlerRegistry = {
        ...completingHandlers,
        "execution.run.v1": async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await held.promise;
          active -= 1;
          return { type: "complete" };
        },
      };
      const taskSystem = await queue(implementation, handlers);
      const submissions = Array.from({ length: 5 }, (_, index) =>
        taskSystem.submit(executionJob(`${scope}_${index}`)),
      );
      await Promise.all(submissions.map(({ accepted }) => accepted));
      await taskSystem.runOnce();
      await Promise.resolve();
      await Promise.resolve();
      expect(active).toBe(4);
      expect(maximum).toBe(4);
      held.resolve();
      await taskSystem.drainOwned();
      await taskSystem.runOnce();
      await taskSystem.drainOwned();
      await Promise.all(submissions.map(({ completed }) => completed));
    });

    it("sanitizes handler throws, releases the slot, and runs the next job", async () => {
      const scope = identity(implementation.name);
      const second = vi.fn(async () => ({ type: "complete" as const }));
      const handlers: JobHandlerRegistry = {
        ...completingHandlers,
        "execution.run.v1": (payload) => {
          if (payload.executionId.endsWith("_first")) {
            throw new Error("sentinel raw handler detail");
          }
          return second();
        },
      };
      const taskSystem = await queue(implementation, handlers, {
        executionConcurrency: 1,
      });
      const firstJob = executionJob(`${scope}_first`);
      const first = taskSystem.submit(firstJob);
      const next = taskSystem.submit(executionJob(`${scope}_second`));
      await Promise.all([first.accepted, next.accepted]);
      await taskSystem.runOnce();
      await taskSystem.drainOwned();
      await taskSystem.runOnce();
      await taskSystem.drainOwned();
      await expect(first.completed).rejects.toMatchObject({
        code: "handler_rejected",
      });
      await expect(next.completed).resolves.toBeUndefined();
      expect(second).toHaveBeenCalledOnce();
      const failed = await taskSystem.jobStore.get(executorJobId(firstJob));
      expect(failed).toMatchObject({
        state: "failed",
        lastErrorCode: "handler_rejected",
      });
    });

    it("settles an attached job completed by a competing worker", async () => {
      const scope = identity(implementation.name);
      const store = await implementation.jobStore();
      const submitter = new ExecutorTaskSystem({
        jobStore: store,
        durable: implementation.durable,
        manual: true,
      });
      const competitor = new ExecutorTaskSystem({
        jobStore: store,
        durable: implementation.durable,
        manual: true,
      });
      submitter.bindHandlers(completingHandlers);
      competitor.bindHandlers(completingHandlers);
      const submission = submitter.submit(executionJob(scope));
      await submission.accepted;
      competitor.start();
      await competitor.runOnce();
      await competitor.drainOwned();
      await submitter.runOnce();
      await expect(submission.completed).resolves.toBeUndefined();
    });

    it("cancels pending work durably and settles attachment without dispatch", async () => {
      const scope = identity(implementation.name);
      const execute = vi.fn(async () => ({ type: "complete" as const }));
      const taskSystem = await queue(implementation, {
        ...completingHandlers,
        "execution.run.v1": execute,
      });
      const job = executionJob(`${scope}_pending_cancel`);
      const submission = taskSystem.submit(job, {
        runAfter: "2099-01-01T00:00:00.000Z",
      });
      await submission.accepted;
      const result = await taskSystem.jobStore.cancelPending({
        jobId: executorJobId(job),
        expectedDescription: job,
        now: "2026-07-18T00:00:01.000Z",
      });
      expect(result).toMatchObject({
        kind: "cancelled",
        job: {
          state: "cancelled",
          completedAt: "2026-07-18T00:00:01.000Z",
        },
      });
      await taskSystem.runOnce();
      await expect(submission.completed).resolves.toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      await expect(
        taskSystem.jobStore.reopenForRecovery({
          jobId: executorJobId(job),
          expectedDescription: job,
          runAfter: "2026-07-18T00:00:02.000Z",
        }),
      ).resolves.toBe(false);
      await expect(
        taskSystem.jobStore.cancelPending({
          jobId: executorJobId(job),
          expectedDescription: job,
          now: "2026-07-18T00:00:03.000Z",
        }),
      ).resolves.toMatchObject({ kind: "already_cancelled" });
    });

    it("preserves a running lease and fences worker cancellation", async () => {
      const scope = identity(implementation.name);
      const store = await implementation.jobStore();
      const job = executionJob(`${scope}_claimed_cancel`);
      const envelope = createJobEnvelope(
        job,
        { runAfter: "2026-07-18T00:00:00.000Z" },
        new Date("2026-07-18T00:00:00.000Z"),
      );
      await store.ensure(envelope);
      const [claimed] = await store.claim({
        queueName: "execution",
        workerId: `worker_${scope}`,
        now: "2026-07-18T00:00:01.000Z",
        leaseExpiresAt: "2026-07-18T00:00:31.000Z",
        limit: 1,
      });
      expect(claimed).toBeDefined();
      if (claimed === undefined) throw new Error("Expected a claimed job.");
      await expect(
        store.cancelPending({
          jobId: envelope.jobId,
          expectedDescription: job,
          now: "2026-07-18T00:00:02.000Z",
        }),
      ).resolves.toMatchObject({
        kind: "running",
        job: { leaseToken: claimed.leaseToken },
      });
      await expect(
        store.cancelClaimed({
          jobId: claimed.jobId,
          workerId: claimed.claimedBy,
          leaseToken: `${claimed.leaseToken}_wrong`,
          now: "2026-07-18T00:00:03.000Z",
        }),
      ).resolves.toBe(false);
      await expect(
        store.cancelClaimed({
          jobId: claimed.jobId,
          workerId: claimed.claimedBy,
          leaseToken: claimed.leaseToken,
          now: "2026-07-18T00:00:03.000Z",
        }),
      ).resolves.toBe(true);
      await expect(store.get(claimed.jobId)).resolves.toMatchObject({
        state: "cancelled",
        completedAt: "2026-07-18T00:00:03.000Z",
      });
    });

    it("lets a cancelled group predecessor unblock the next member", async () => {
      const scope = identity(implementation.name);
      const store = await implementation.jobStore();
      const first = executionJob(`${scope}_group_first`);
      const second = executionJob(`${scope}_group_second`);
      const runAfter = "2026-07-18T00:00:00.000Z";
      const now = new Date(runAfter);
      await store.ensure(
        createJobEnvelope(
          first,
          { runAfter, groupKey: `group_${scope}`, groupOrder: 1 },
          now,
        ),
      );
      await store.ensure(
        createJobEnvelope(
          second,
          { runAfter, groupKey: `group_${scope}`, groupOrder: 2 },
          now,
        ),
      );
      await store.cancelPending({
        jobId: executorJobId(first),
        expectedDescription: first,
        now: "2026-07-18T00:00:01.000Z",
      });
      const claimed = await store.claim({
        queueName: "execution",
        workerId: `worker_${scope}`,
        now: "2026-07-18T00:00:02.000Z",
        leaseExpiresAt: "2026-07-18T00:00:32.000Z",
        limit: 1,
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.jobId).toBe(executorJobId(second));
    });

    it("persists a cancelled handler result and resolves the submission", async () => {
      const scope = identity(implementation.name);
      const taskSystem = await queue(implementation, {
        ...completingHandlers,
        "execution.run.v1": async () => ({ type: "cancelled" }),
      });
      const job = executionJob(`${scope}_handler_cancel`);
      const submission = taskSystem.submit(job);
      await submission.accepted;
      await taskSystem.runOnce();
      await taskSystem.drainOwned();
      await expect(submission.completed).resolves.toBeUndefined();
      await expect(
        taskSystem.jobStore.get(executorJobId(job)),
      ).resolves.toMatchObject({ state: "cancelled" });
    });

    it("validates every configured lane concurrency", async () => {
      const store = await implementation.jobStore();
      for (const value of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(
          () =>
            new ExecutorTaskSystem({
              jobStore: store,
              executionConcurrency: value,
            }),
        ).toThrow(/positive safe integer/iu);
      }
    });

    if (implementation.durable) {
      it("hands off a future durable job without deleting it", async () => {
        const scope = identity(implementation.name);
        const taskSystem = await queue(implementation, completingHandlers);
        const submission = taskSystem.submit(executionJob(scope), {
          runAfter: "2099-01-01T00:00:00.000Z",
        });
        await submission.accepted;
        await taskSystem.stopClaiming();
        await taskSystem.handoffPending();
        await expect(submission.completed).rejects.toBeInstanceOf(
          QueueHandoffError,
        );
        const rows = await taskSystem.jobStore.claim({
          queueName: "execution",
          workerId: `future_${scope}`,
          now: "2098-12-31T23:59:59.000Z",
          leaseExpiresAt: "2099-01-01T00:00:29.000Z",
          limit: 1,
        });
        expect(rows).toEqual([]);
      });
    }
  });
}
