import { defaultCatalog } from "@eyeball/catalog";
import type { CapabilitySlug } from "@eyeball/core";
import { describe, expect, it, type TestContext } from "vitest";
import {
  assertAuthExpired,
  assertCanonicalSuccess,
  assertNotSupported,
} from "./assertions.js";
import {
  type CanonicalFixture,
  type CapabilityFixtureRegistry,
  type ContractTarget,
  createFixtureContext,
  fixtureInput,
  MissingRealConfigurationError,
} from "./fixtures.js";
import {
  CONTRACT_SUITE_VERSION,
  type ContractReportRow,
  recordContractAssertion,
  recordContractRow,
} from "./report.js";
import { createContractTargetHarness, hasMockDefinition } from "./targets.js";

export interface DescribeCapabilityConfig {
  readonly target: ContractTarget;
  readonly registry: CapabilityFixtureRegistry;
}

function implementedTools(
  manifest: ReturnType<typeof defaultCatalog.getManifest> & object,
  capability: CapabilitySlug,
): Set<string> {
  return new Set(
    manifest.implements
      .filter((implementation) => implementation.capability === capability)
      .map((implementation) => implementation.canonicalTool),
  );
}

function validateRegistry(registry: CapabilityFixtureRegistry): void {
  if (registry.capability.length === 0) {
    throw new Error("A contract fixture registry must name its capability.");
  }
  const contracts = defaultCatalog.listContracts({
    capability: registry.capability,
  });
  const contractNames = new Set(contracts.map((contract) => contract.name));
  const missing = contracts
    .map((contract) => contract.name)
    .filter((name) => registry.fixtures[name] === undefined);
  const unknown = Object.keys(registry.fixtures).filter(
    (name) => !contractNames.has(name),
  );
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `Fixture registry ${registry.capability} is incomplete: ` +
        `missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}].`,
    );
  }
}

async function executeFixture(options: {
  capability: CapabilitySlug;
  tool: string;
  provider: string;
  target: ContractTarget;
  fixtureRegistry: Readonly<Record<string, CanonicalFixture>>;
  supported: ReadonlySet<string>;
  targetHarness: ReturnType<typeof createContractTargetHarness>;
  outputs: Map<string, Readonly<Record<string, unknown>>>;
  visiting: Set<string>;
}): Promise<Readonly<Record<string, unknown>>> {
  const existing = options.outputs.get(options.tool);
  if (existing !== undefined) {
    return existing;
  }
  if (options.visiting.has(options.tool)) {
    throw new Error(`Fixture dependency cycle at ${options.tool}.`);
  }
  const fixture = options.fixtureRegistry[options.tool];
  if (fixture === undefined) {
    throw new Error(`Missing canonical fixture for ${options.tool}.`);
  }
  if (!options.supported.has(options.tool)) {
    throw new Error(
      `${options.provider}.${options.tool} is required by a fixture but omitted by its manifest.`,
    );
  }

  options.visiting.add(options.tool);
  for (const dependency of fixture.dependencies ?? []) {
    await executeFixture({ ...options, tool: dependency });
  }
  options.visiting.delete(options.tool);

  const context = createFixtureContext({
    provider: options.provider,
    target: options.target,
    outputs: options.outputs,
    harness: options.targetHarness.harness,
  });
  const contract = defaultCatalog
    .listContracts({ capability: options.capability })
    .find((candidate) => candidate.name === options.tool);
  if (contract === undefined) {
    throw new Error(
      `Unknown canonical contract ${options.capability}.${options.tool}.`,
    );
  }
  const mode = fixture.mode ?? (contract.annotations.async ? "async" : "sync");
  const result = await options.targetHarness.harness.execute(
    `${options.provider}.${options.tool}`,
    fixtureInput(fixture, context),
    mode,
  );
  const output = assertCanonicalSuccess({
    capability: options.capability,
    tool: options.tool,
    result,
    mode,
  });
  options.outputs.set(options.tool, output);
  await fixture.after?.(context);
  return output;
}

function skipReasonForFixture(
  fixture: CanonicalFixture,
  target: ContractTarget,
): string | undefined {
  if (
    fixture.exclusion !== undefined &&
    (fixture.exclusion.target === "all" || fixture.exclusion.target === target)
  ) {
    return fixture.exclusion.reason;
  }
  return undefined;
}

function recordDynamicSkip(options: {
  readonly testContext: TestContext;
  readonly row: Omit<ContractReportRow, "outcome" | "reason" | "quirk">;
  readonly error: MissingRealConfigurationError;
}): void {
  const reason = `skipped: ${options.error.message}`;
  recordContractRow({
    ...options.row,
    outcome: "skipped",
    reason,
  });
  options.testContext.skip(reason);
}

export function describeCapability(
  capability: CapabilitySlug,
  config: DescribeCapabilityConfig,
): void {
  if (config.registry.capability !== capability) {
    throw new Error(
      `Fixture registry ${config.registry.capability} cannot describe ${capability}.`,
    );
  }
  validateRegistry(config.registry);
  const manifests = defaultCatalog.listManifests({ capability });
  const contracts = defaultCatalog.listContracts({ capability });
  if (manifests.length === 0 || contracts.length === 0) {
    throw new Error(
      `Capability ${capability} has no manifest-derived contract matrix.`,
    );
  }

  describe(`${capability} contracts (${config.target})`, () => {
    for (const manifest of manifests) {
      const provider = manifest.toolkit.slug;
      if (config.target === "mock" && !hasMockDefinition(provider)) {
        throw new Error(
          `Catalog provider ${provider} has no registered mock target.`,
        );
      }
      const supported = implementedTools(manifest, capability);
      for (const contract of contracts) {
        const fixture = config.registry.fixtures[contract.name];
        if (fixture === undefined) {
          throw new Error(
            `Missing fixture for ${capability}.${contract.name}.`,
          );
        }
        const row = {
          capability,
          provider,
          tool: contract.name,
          canonicalVersion: contract.version,
          fixtureVersion: config.registry.version,
          manifestCatalogVersion: manifest.catalogVersion,
          manifestSchemaVersion: manifest.schemaVersion,
          suiteVersion: CONTRACT_SUITE_VERSION,
          target: config.target,
        } as const;

        if (!supported.has(contract.name)) {
          it(`${provider}.${contract.name} -> not_supported without traffic`, async () => {
            const targetHarness = createContractTargetHarness(
              manifest,
              config.target,
            );
            const before = targetHarness.harness.providerRequestCount();
            const context = createFixtureContext({
              provider,
              target: "mock",
              outputs: new Map(),
              harness: targetHarness.harness,
              allowMissingOutputs: true,
            });
            try {
              const result = await targetHarness.harness.execute(
                `${provider}.${contract.name}`,
                fixtureInput(fixture, context),
              );
              assertNotSupported(result);
              expect(targetHarness.harness.providerRequestCount()).toBe(before);
              recordContractRow({ ...row, outcome: "not_supported" });
            } catch (error) {
              recordContractRow({
                ...row,
                outcome: "fail",
                reason: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          });
          continue;
        }

        const exclusion = skipReasonForFixture(fixture, config.target);
        const readiness = createContractTargetHarness(
          manifest,
          config.target,
        ).readiness;
        const staticSkip = exclusion ?? readiness;
        if (staticSkip !== undefined) {
          recordContractRow({
            ...row,
            outcome: "skipped",
            reason: staticSkip,
            ...(exclusion === undefined ? {} : { quirk: exclusion }),
          });
          it.skip(`${provider}.${contract.name} -> skipped (${staticSkip})`, () => {});
          continue;
        }

        it(`${provider}.${contract.name} -> canonical smoke`, async (testContext) => {
          const targetHarness = createContractTargetHarness(
            manifest,
            config.target,
          );
          try {
            await targetHarness.initialize();
            await executeFixture({
              capability,
              tool: contract.name,
              provider,
              target: config.target,
              fixtureRegistry: config.registry.fixtures,
              supported,
              targetHarness,
              outputs: new Map(),
              visiting: new Set(),
            });
            recordContractRow({ ...row, outcome: "pass" });
          } catch (error) {
            if (error instanceof MissingRealConfigurationError) {
              recordDynamicSkip({ row, testContext, error });
              return;
            }
            recordContractRow({
              ...row,
              outcome: "fail",
              reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        });
      }

      const assertion = {
        capability,
        provider,
        assertion: "EXPIRED_TOKEN -> auth_expired",
        target: config.target,
      } as const;
      if (manifest.auth.class === "none") {
        const reason = "auth class none has no expiring credential";
        recordContractAssertion({ ...assertion, outcome: "skipped", reason });
        it.skip(`${provider} EXPIRED_TOKEN -> skipped (${reason})`, () => {});
        continue;
      }
      const probe = [...supported].find(
        (tool) =>
          (config.registry.fixtures[tool]?.dependencies?.length ?? 0) === 0,
      );
      if (probe === undefined) {
        throw new Error(
          `${provider} has no standalone fixture for auth probing.`,
        );
      }
      const readiness = createContractTargetHarness(
        manifest,
        config.target,
      ).readiness;
      if (readiness !== undefined) {
        recordContractAssertion({
          ...assertion,
          outcome: "skipped",
          reason: readiness,
        });
        it.skip(`${provider} EXPIRED_TOKEN -> skipped (${readiness})`, () => {});
        continue;
      }

      it(`${provider} EXPIRED_TOKEN -> auth_expired`, async () => {
        const targetHarness = createContractTargetHarness(
          manifest,
          config.target,
          {
            expired: true,
          },
        );
        try {
          await targetHarness.initialize();
          const fixture = config.registry.fixtures[probe];
          if (fixture === undefined) {
            throw new Error(`Missing auth probe fixture ${probe}.`);
          }
          const context = createFixtureContext({
            provider,
            target: config.target,
            outputs: new Map(),
            harness: targetHarness.harness,
          });
          const result = await targetHarness.harness.execute(
            `${provider}.${probe}`,
            fixtureInput(fixture, context),
            fixture.mode ?? "sync",
          );
          assertAuthExpired(result);
          recordContractAssertion({ ...assertion, outcome: "pass" });
        } catch (error) {
          recordContractAssertion({
            ...assertion,
            outcome: "fail",
            reason: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
    }
  });
}
