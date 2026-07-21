import { createExecutionId } from "@eyeball/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionStore,
  StoredMcpSession,
  StoredMcpTask,
} from "../../src/session-store.js";

export interface SessionStoreContractImplementation {
  name: string;
  createStore(): Promise<SessionStore>;
}

let sequence = 0;

function identity(label: string): string {
  sequence += 1;
  return `${label.replaceAll(/[^a-z0-9]/giu, "_")}_${sequence}`;
}

function task(label: string): StoredMcpTask {
  const taskId = createExecutionId(label);
  return {
    taskId,
    tool: "gmail.list_emails",
    executionStatus: "running",
    status: "working",
    createdAt: "2026-07-20T05:00:00.000Z",
    lastUpdatedAt: "2026-07-20T05:00:01.000Z",
    ttl: 120_000,
    pollInterval: 1_000,
    progress: 0.25,
  };
}

function session(label: string): StoredMcpSession {
  return {
    sessionId: `session_${label}`,
    protocolVersion: "2025-06-18",
    authBinding: `binding_${label}`,
    tasksEnabled: true,
    createdAt: "2026-07-20T05:00:00.000Z",
    expiresAt: "2026-07-20T06:00:00.000Z",
    catalogVersion: "1.1",
    tasks: {},
  };
}

export function registerSessionStoreContractSuite(
  implementations: readonly SessionStoreContractImplementation[],
): void {
  describe.each(
    implementations,
  )("$name SessionStore contract", (implementation) => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await implementation.createStore();
    });

    it("detaches set/get values and applies full replacement", async () => {
      const value = session(identity(implementation.name));
      await store.set(value);
      (value as { authBinding: string }).authBinding = "mutated_input";
      const first = await store.get(value.sessionId);
      expect(first).toMatchObject({
        authBinding: expect.stringMatching(/^binding_/u),
      });
      if (first === undefined) throw new Error("Expected stored session.");
      (first as { authBinding: string }).authBinding = "mutated_output";
      expect(await store.get(value.sessionId)).not.toMatchObject({
        authBinding: "mutated_output",
      });

      const { catalogVersion: _catalogVersion, ...withoutCatalog } = value;
      await store.set({
        ...withoutCatalog,
        authBinding: "replacement_binding",
        tasksEnabled: false,
        tasks: { replacement: task("replacement") },
      });
      await expect(store.get(value.sessionId)).resolves.toMatchObject({
        authBinding: "replacement_binding",
        tasksEnabled: false,
        tasks: { replacement: { status: "working" } },
      });
    });

    it("does not invoke an updater for a missing row", async () => {
      const updater = vi.fn((value: StoredMcpSession) => value);
      await expect(
        store.update("missing_session", updater),
      ).resolves.toBeUndefined();
      expect(updater).not.toHaveBeenCalled();
    });

    it("atomically persists detached updates and deletes on undefined", async () => {
      const value = session(identity(implementation.name));
      await store.set(value);
      const updated = await store.update(value.sessionId, (current) => ({
        ...current,
        catalogVersion: "2.0",
      }));
      expect(updated).toMatchObject({ catalogVersion: "2.0" });
      if (updated === undefined) throw new Error("Expected updated session.");
      (updated as { catalogVersion?: string }).catalogVersion = "mutated";
      await expect(store.get(value.sessionId)).resolves.toMatchObject({
        catalogVersion: "2.0",
      });
      await expect(
        store.update(value.sessionId, () => undefined),
      ).resolves.toBeUndefined();
      await expect(store.get(value.sessionId)).resolves.toBeUndefined();
      await expect(store.delete(value.sessionId)).resolves.toBe(false);
    });

    it("reports deletion only when a row existed", async () => {
      const value = session(identity(implementation.name));
      await store.set(value);
      await expect(store.delete(value.sessionId)).resolves.toBe(true);
      await expect(store.delete(value.sessionId)).resolves.toBe(false);
    });

    it("serializes concurrent whole-session task transitions", async () => {
      const value = session(identity(implementation.name));
      const firstTask = task(`first_${sequence}`);
      const secondTask = task(`second_${sequence}`);
      await store.set(value);
      await Promise.all([
        store.update(value.sessionId, (current) => ({
          ...current,
          tasks: { ...current.tasks, [firstTask.taskId]: firstTask },
        })),
        store.update(value.sessionId, (current) => ({
          ...current,
          tasks: { ...current.tasks, [secondTask.taskId]: secondTask },
        })),
      ]);
      const persisted = await store.get(value.sessionId);
      expect(Object.keys(persisted?.tasks ?? {}).sort()).toEqual(
        [firstTask.taskId, secondTask.taskId].sort(),
      );
    });

    it("rolls back a thrown updater", async () => {
      const value = session(identity(implementation.name));
      await store.set(value);
      await expect(
        store.update(value.sessionId, () => {
          throw new Error("updater failed");
        }),
      ).rejects.toThrow("updater failed");
      await expect(store.get(value.sessionId)).resolves.toEqual(value);
    });

    it("stores credential bindings without inventing project identity", async () => {
      const label = identity(implementation.name);
      const first = session(`${label}_first`);
      const second = {
        ...session(`${label}_second`),
        authBinding: first.authBinding,
      };
      await store.set(first);
      await store.set(second);
      await expect(store.get(first.sessionId)).resolves.toEqual(first);
      await expect(store.get(second.sessionId)).resolves.toEqual(second);
      expect(Object.keys(first).sort()).not.toContain("projectId");
      expect(Object.keys(first).sort()).not.toContain("userId");
    });
  });
}
