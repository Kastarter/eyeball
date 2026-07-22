import type { CredentialProvider } from "@eyeball/core";
import type { TaskQueue } from "./queue.js";

export interface ReadinessProbe {
  check(signal?: AbortSignal): Promise<void>;
}

export interface DatabaseReadinessProbes {
  readonly connectivity: ReadinessProbe;
  readonly migrations: ReadinessProbe;
}

export type ReadinessCheckStatus = "ok" | "error";

export interface ExecutorReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly service: "executor";
  readonly checks: {
    readonly database: { readonly status: ReadinessCheckStatus };
    readonly migrations: { readonly status: ReadinessCheckStatus };
    readonly credentials: { readonly status: ReadinessCheckStatus };
    readonly queue: { readonly status: ReadinessCheckStatus };
  };
}

export interface ExecutorReadiness {
  inspect(): Promise<ExecutorReadinessReport>;
}

export interface CreateExecutorReadinessOptions {
  readonly database?: DatabaseReadinessProbes;
  readonly credentialProvider: CredentialProvider;
  readonly queue: TaskQueue;
  /** Per-check hard deadline; all checks still run concurrently. */
  readonly probeTimeoutMs?: number;
}

type ReadinessCredentialProvider = CredentialProvider & {
  checkReadiness?: (signal?: AbortSignal) => Promise<void>;
  list?: () => Promise<unknown>;
};

export const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 10_000;

const alwaysReady: ReadinessProbe = {
  check: async () => {},
};

async function inspectProbe(
  probe: ReadinessProbe,
  timeoutMs: number,
): Promise<{ readonly status: ReadinessCheckStatus }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Readiness probe exceeded its deadline.");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => probe.check(controller.signal)),
      deadline,
    ]);
    return { status: "ok" };
  } catch {
    return { status: "error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function probeTimeout(value: number | undefined): number {
  const resolved = value ?? DEFAULT_READINESS_PROBE_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(
      "Readiness probe timeout must be a positive safe integer.",
    );
  }
  return resolved;
}

/** Aggregates dependency-owned probes without exposing their errors or config. */
export function createExecutorReadiness(
  options: CreateExecutorReadinessOptions,
): ExecutorReadiness {
  const timeoutMs = probeTimeout(options.probeTimeoutMs);
  const credentialProvider =
    options.credentialProvider as ReadinessCredentialProvider;
  const credentialProbe: ReadinessProbe = {
    check: async (signal) => {
      if (credentialProvider.checkReadiness !== undefined) {
        await credentialProvider.checkReadiness(signal);
        return;
      }
      if (
        credentialProvider.kind === "mock" ||
        credentialProvider.kind === "env"
      ) {
        return;
      }
      if (
        credentialProvider.kind === "local-vault" &&
        credentialProvider.list !== undefined
      ) {
        await credentialProvider.list();
        return;
      }
      throw new Error(
        "The configured credential provider has no readiness probe.",
      );
    },
  };
  const queueProbe: ReadinessProbe = {
    check: async (signal) => {
      await options.queue.checkReadiness(signal);
    },
  };

  return {
    inspect: async () => {
      const [database, migrations, credentials, queue] = await Promise.all([
        inspectProbe(options.database?.connectivity ?? alwaysReady, timeoutMs),
        inspectProbe(options.database?.migrations ?? alwaysReady, timeoutMs),
        inspectProbe(credentialProbe, timeoutMs),
        inspectProbe(queueProbe, timeoutMs),
      ]);
      const checks = { database, migrations, credentials, queue };
      const ready = Object.values(checks).every(
        (check) => check.status === "ok",
      );
      return {
        status: ready ? "ready" : "not_ready",
        service: "executor",
        checks,
      };
    },
  };
}
