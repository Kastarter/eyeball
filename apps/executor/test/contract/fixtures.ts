import type { CapabilitySlug, JsonValue } from "@eyeball/core";
import type { InProcessExecutorHarness } from "../helpers/executor-harness.js";

export type ContractTarget = "mock" | "real";
export type CanonicalInput = Readonly<Record<string, JsonValue>>;
export const CANONICAL_FIXTURE_VERSION = "1.0.0";

export class MissingRealConfigurationError extends Error {
  readonly envName: string;

  constructor(envName: string) {
    super(`missing ${envName}`);
    this.name = "MissingRealConfigurationError";
    this.envName = envName;
  }
}

export interface FixtureContext {
  readonly provider: string;
  readonly target: ContractTarget;
  value(name: string, mockValue: string): string;
  output(tool: string): Readonly<Record<string, unknown>>;
  field(tool: string, ...path: readonly string[]): string;
  advanceClock(milliseconds: number): Promise<void>;
}

export interface CanonicalFixture {
  readonly input:
    | CanonicalInput
    | ((context: FixtureContext) => CanonicalInput);
  readonly dependencies?: readonly string[];
  readonly mode?: "sync" | "async";
  readonly after?: (context: FixtureContext) => Promise<void>;
  readonly exclusion?: {
    readonly target: ContractTarget | "all";
    readonly reason: string;
  };
}

export interface CapabilityFixtureRegistry {
  readonly capability: CapabilitySlug;
  readonly version: string;
  readonly mockSeed: "default";
  readonly fixtures: Readonly<Record<string, CanonicalFixture>>;
}

export function defineCapabilityFixtures(
  capability: CapabilitySlug,
  fixtures: Readonly<Record<string, CanonicalFixture>>,
): CapabilityFixtureRegistry {
  return {
    capability,
    version: CANONICAL_FIXTURE_VERSION,
    mockSeed: "default",
    fixtures,
  };
}

function environmentName(toolkitSlug: string, name: string): string {
  return `EYEBALL_REAL_${toolkitSlug.toUpperCase().replaceAll("-", "_")}_${name}`;
}

function nestedField(
  value: Readonly<Record<string, unknown>>,
  path: readonly string[],
): string {
  let current: unknown = value;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      throw new Error(
        `Fixture output path ${path.join(".")} is not an object.`,
      );
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  if (typeof current !== "string" && typeof current !== "number") {
    throw new Error(`Fixture output path ${path.join(".")} is not scalar.`);
  }
  return String(current);
}

export function createFixtureContext(options: {
  provider: string;
  target: ContractTarget;
  outputs: Map<string, Readonly<Record<string, unknown>>>;
  harness: InProcessExecutorHarness;
  allowMissingOutputs?: boolean;
}): FixtureContext {
  return {
    provider: options.provider,
    target: options.target,
    value(name, mockValue) {
      if (options.target === "mock") {
        return mockValue;
      }
      const envName = environmentName(options.provider, name);
      const value = process.env[envName];
      if (value === undefined || value.length === 0) {
        throw new MissingRealConfigurationError(envName);
      }
      return value;
    },
    output(tool) {
      const output = options.outputs.get(tool);
      if (output === undefined) {
        throw new Error(`Fixture dependency ${tool} has no recorded output.`);
      }
      return output;
    },
    field(tool, ...path) {
      const output = options.outputs.get(tool);
      if (output === undefined) {
        if (options.allowMissingOutputs === true) {
          return `fixture_${tool}_${path.join("_")}`;
        }
        throw new Error(`Fixture dependency ${tool} has no recorded output.`);
      }
      return nestedField(output, path);
    },
    advanceClock: (milliseconds) => options.harness.advanceClock(milliseconds),
  };
}

export function fixtureInput(
  fixture: CanonicalFixture,
  context: FixtureContext,
): CanonicalInput {
  return typeof fixture.input === "function"
    ? fixture.input(context)
    : fixture.input;
}
