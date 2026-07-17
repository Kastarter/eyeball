import { defaultCatalog } from "@eyeball/catalog";
import { type CapabilitySlug, validateInput } from "@eyeball/core";
import { expect } from "vitest";
import {
  executionOutput,
  type HarnessExecuteResult,
} from "../helpers/executor-harness.js";

export function assertCanonicalSuccess(options: {
  readonly capability: CapabilitySlug;
  readonly tool: string;
  readonly result: HarnessExecuteResult;
  readonly mode: "sync" | "async";
}): Readonly<Record<string, unknown>> {
  const contract = defaultCatalog
    .listContracts({ capability: options.capability })
    .find((candidate) => candidate.name === options.tool);
  if (contract?.outputSchema === undefined) {
    throw new Error(
      `${options.capability}.${options.tool} has no canonical output schema.`,
    );
  }

  expect(options.result.initialStatus).toBe(
    options.mode === "async" ? 202 : 200,
  );
  expect(options.result.initial.executionId).toEqual(expect.any(String));
  expect(options.result.initial.tool).toEqual(
    expect.stringMatching(`\\.${options.tool}$`),
  );
  expect(options.result.initial.toolVersion).toBe(contract.version);
  expect(options.result.initial.catalogVersion).toBe(
    defaultCatalog.catalogVersion,
  );
  if (options.mode === "async") {
    expect(options.result.initial.status).toBe("pending");
  }

  expect(
    options.result.terminal,
    JSON.stringify(options.result.terminal),
  ).toMatchObject({
    executionId: options.result.initial.executionId,
    status: "succeeded",
    tool: options.result.initial.tool,
    toolVersion: contract.version,
    catalogVersion: defaultCatalog.catalogVersion,
  });
  expect(options.result.terminal.error).toBeUndefined();
  expect(options.result.terminal.latencyMs).toEqual(expect.any(Number));
  expect(options.result.terminal.latencyMs).toBeGreaterThanOrEqual(0);

  const output = executionOutput(options.result);
  const validation = validateInput(
    { inputSchema: contract.outputSchema },
    output,
  );
  expect(validation, JSON.stringify(validation)).toMatchObject({ ok: true });
  return output;
}

export function assertNotSupported(result: HarnessExecuteResult): void {
  expect(result.initialStatus).toBe(422);
  expect(result.initial).toMatchObject({
    error: { code: "not_supported", retryable: false },
  });
  expect(result.initial.executionId).toBeUndefined();
}

export function assertAuthExpired(result: HarnessExecuteResult): void {
  expect(result.terminal).toMatchObject({
    status: "failed",
    error: { code: "auth_expired", retryable: false },
  });
  expect(result.terminal.executionId).toEqual(expect.any(String));
  expect(result.terminal.output).toBeUndefined();
  expect(result.terminal.latencyMs).toEqual(expect.any(Number));
}
