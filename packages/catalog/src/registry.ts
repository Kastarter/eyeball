import {
  AUTH_CLASSES,
  CAPABILITY_SLUGS,
  type CapabilitySlug,
  type CapabilityToolContract,
  type CatalogManifest,
  type CatalogVersion,
  DELIVERY_TIERS,
  isCanonicalToolName,
  JSON_SCHEMA_DRAFT_2020_12,
  type ObjectSchema202012,
  PROVIDER_SOURCES,
  type ProviderManifest,
  type ProviderToolImplementation,
  type SemVer,
  type ToolDefinition,
  type Toolkit,
  validateCanonicalToolName,
  validateInput,
} from "@eyeball/core";
import {
  getCapabilityCatalogEntry,
  getProviderCatalogEntry,
} from "./catalog.js";
import { deepFreeze } from "./immutable.js";

export interface CatalogRegistryOptions {
  catalogVersion?: CatalogVersion;
  contracts?: readonly CapabilityToolContract[];
  manifests?: readonly ProviderManifest[];
}

export interface ListToolsFilters {
  capability?: CapabilitySlug;
  toolkit?: string;
  tier?: Toolkit["tier"];
}

export interface ListContractsFilters {
  capability?: CapabilitySlug;
  name?: string;
  version?: SemVer;
}

export interface ListManifestsFilters {
  capability?: CapabilitySlug;
  tier?: Toolkit["tier"];
}

export interface EffectiveScopes {
  required: readonly string[];
  optional: readonly string[];
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const CATALOG_VERSION_PATTERN = /^\d+\.\d+$/;
const BASE_URL_OVERRIDE_ENV_PATTERN =
  /^EYEBALL_[A-Z0-9]+(?:_[A-Z0-9]+)*_BASE_URL$/;
const ANNOTATION_KEYS = [
  "readOnly",
  "destructive",
  "idempotent",
  "async",
] as const;

function contractKey(
  capability: CapabilitySlug,
  name: string,
  version: SemVer,
): string {
  return `${capability}:${name}:${version}`;
}

function implementationKey(implementation: ProviderToolImplementation): string {
  return contractKey(
    implementation.capability,
    implementation.canonicalTool,
    implementation.canonicalVersion,
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertCapability(
  capability: string,
  context: string,
): asserts capability is CapabilitySlug {
  if (!(CAPABILITY_SLUGS as readonly string[]).includes(capability)) {
    throw new Error(`${context} has unknown capability: ${capability}`);
  }
}

function assertSemVer(
  version: string,
  context: string,
): asserts version is SemVer {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`${context} has invalid semantic version: ${version}`);
  }
}

function assertCatalogVersion(
  version: string,
  context: string,
): asserts version is CatalogVersion {
  if (!CATALOG_VERSION_PATTERN.test(version)) {
    throw new Error(`${context} has invalid catalog version: ${version}`);
  }
}

function assertNonEmpty(value: string, context: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${context} must not be empty.`);
  }
}

function assertStringList(
  values: readonly string[] | undefined,
  context: string,
): void {
  if (values === undefined) {
    return;
  }

  const seen = new Set<string>();
  for (const value of values) {
    assertNonEmpty(value, context);
    if (seen.has(value)) {
      throw new Error(`${context} contains duplicate value: ${value}`);
    }
    seen.add(value);
  }
}

function assertSchema(schema: ObjectSchema202012, context: string): void {
  const result = validateInput({ inputSchema: schema }, {});
  if (result.ok) {
    return;
  }

  const profileIssue = result.errors.find(
    ({ keyword }) => keyword === "schema_profile",
  );
  if (profileIssue !== undefined) {
    throw new Error(`${context} is invalid: ${profileIssue.message}`);
  }
}

function assertExtensionSchema(
  schema: ObjectSchema202012,
  context: string,
): void {
  if (
    schema.$schema !== undefined &&
    schema.$schema !== JSON_SCHEMA_DRAFT_2020_12
  ) {
    throw new Error(
      `${context} must use ${JSON_SCHEMA_DRAFT_2020_12} when it declares $schema.`,
    );
  }

  assertSchema({ ...schema, $schema: JSON_SCHEMA_DRAFT_2020_12 }, context);
}

function assertContract(contract: CapabilityToolContract): void {
  assertCapability(contract.capability, `Contract ${contract.name}`);
  assertSemVer(
    contract.version,
    `Contract ${contract.capability}.${contract.name}`,
  );
  validateCanonicalToolName(`catalog.${contract.name}`);

  const context = `Contract ${contract.capability}.${contract.name}`;
  assertNonEmpty(contract.description, `${context} description`);
  const annotationEntries = Object.entries(contract.annotations);
  if (
    annotationEntries.length !== ANNOTATION_KEYS.length ||
    ANNOTATION_KEYS.some(
      (key) => typeof contract.annotations[key] !== "boolean",
    ) ||
    annotationEntries.some(
      ([key]) => !(ANNOTATION_KEYS as readonly string[]).includes(key),
    )
  ) {
    throw new Error(
      `${context} must declare exactly the four boolean annotations.`,
    );
  }
  if (
    contract.inputSchema.properties?.x_provider !== undefined ||
    contract.outputSchema?.properties?.x_provider !== undefined
  ) {
    throw new Error(
      `${context} must not define the reserved x_provider property.`,
    );
  }

  assertSchema(
    contract.inputSchema,
    `Input schema for ${contract.capability}.${contract.name}`,
  );
  if (contract.outputSchema !== undefined) {
    assertSchema(
      contract.outputSchema,
      `Output schema for ${contract.capability}.${contract.name}`,
    );
  }
}

function assertToolkitSlug(slug: string): void {
  validateCanonicalToolName(`${slug}.catalog_probe`);
}

function assertManifestHeader(
  manifest: ProviderManifest,
  catalogVersion: CatalogVersion,
): void {
  const context = `Manifest ${manifest.toolkit.slug}`;
  if (manifest.schemaVersion !== "1.0") {
    throw new Error(`${context} has unsupported schema version.`);
  }
  assertCatalogVersion(manifest.catalogVersion, context);
  if (manifest.catalogVersion !== catalogVersion) {
    throw new Error(
      `${context} targets catalog ${manifest.catalogVersion}; registry targets ${catalogVersion}.`,
    );
  }

  assertToolkitSlug(manifest.toolkit.slug);
  assertNonEmpty(manifest.toolkit.displayName, `${context} display name`);
  if (
    !(PROVIDER_SOURCES as readonly string[]).includes(manifest.toolkit.source)
  ) {
    throw new Error(
      `${context} has unknown provider source: ${manifest.toolkit.source}`,
    );
  }
  if (!(DELIVERY_TIERS as readonly string[]).includes(manifest.toolkit.tier)) {
    throw new Error(
      `${context} has unknown delivery tier: ${manifest.toolkit.tier}`,
    );
  }
  if (!(AUTH_CLASSES as readonly string[]).includes(manifest.auth.class)) {
    throw new Error(
      `${context} has unknown auth class: ${manifest.auth.class}`,
    );
  }

  assertStringList(manifest.auth.requiredScopes, `${context} required scopes`);
  assertStringList(manifest.auth.optionalScopes, `${context} optional scopes`);
  assertStringList(manifest.auth.fields, `${context} auth fields`);
  const requiredScopes = new Set(manifest.auth.requiredScopes ?? []);
  for (const scope of manifest.auth.optionalScopes ?? []) {
    if (requiredScopes.has(scope)) {
      throw new Error(
        `${context} declares scope as both required and optional: ${scope}`,
      );
    }
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(manifest.endpoint.baseUrl);
  } catch {
    throw new Error(`${context} has invalid endpoint base URL.`);
  }
  if (
    (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") ||
    baseUrl.username !== "" ||
    baseUrl.password !== "" ||
    baseUrl.search !== "" ||
    baseUrl.hash !== ""
  ) {
    throw new Error(
      `${context} endpoint must be an HTTP(S) base URL without credentials, query, or fragment.`,
    );
  }
  if (
    manifest.endpoint.baseUrlOverrideEnv !== undefined &&
    !BASE_URL_OVERRIDE_ENV_PATTERN.test(manifest.endpoint.baseUrlOverrideEnv)
  ) {
    throw new Error(
      `${context} has invalid base URL override environment variable.`,
    );
  }
  if (manifest.implements.length === 0) {
    throw new Error(`${context} must implement at least one canonical tool.`);
  }
}

function assertCatalogProviderIdentity(manifest: ProviderManifest): void {
  const provider = getProviderCatalogEntry(manifest.toolkit.slug);
  if (provider === undefined) {
    throw new Error(
      `Manifest ${manifest.toolkit.slug} is not present in catalog 1.0.`,
    );
  }
  if (
    provider.toolkit.displayName !== manifest.toolkit.displayName ||
    provider.toolkit.source !== manifest.toolkit.source ||
    provider.toolkit.tier !== manifest.toolkit.tier ||
    provider.authClass !== manifest.auth.class
  ) {
    throw new Error(
      `Manifest ${manifest.toolkit.slug} disagrees with its catalog 1.0 provider metadata.`,
    );
  }
}

function providerSchemaId(
  schema: ObjectSchema202012,
  implementation: ProviderToolImplementation,
  toolkit: string,
  direction: "input" | "output",
): string {
  const canonicalId = schema.$id;
  if (canonicalId !== undefined) {
    return `${canonicalId}:${toolkit}`;
  }

  const outputSegment = direction === "output" ? ":output" : "";
  return `urn:eyeball:${implementation.capability}:${implementation.canonicalTool}${outputSegment}:${implementation.canonicalVersion}:${toolkit}`;
}

function graftExtension(
  schema: ObjectSchema202012,
  toolkit: string,
  extension: ObjectSchema202012 | undefined,
): ObjectSchema202012 {
  if (extension === undefined) {
    return schema;
  }

  const existingProviderProperty = schema.properties?.x_provider;
  if (existingProviderProperty !== undefined) {
    throw new Error(
      "Capability contracts must not define the reserved x_provider property.",
    );
  }

  return {
    ...schema,
    properties: {
      ...schema.properties,
      x_provider: {
        type: "object",
        additionalProperties: false,
        properties: {
          [toolkit]: clone(extension),
        },
      },
    },
  };
}

function materializeSchema(
  schema: ObjectSchema202012,
  implementation: ProviderToolImplementation,
  toolkit: string,
  direction: "input" | "output",
): ObjectSchema202012 {
  const copied = clone(schema);
  copied.$id = providerSchemaId(copied, implementation, toolkit, direction);

  return graftExtension(
    copied,
    toolkit,
    direction === "input"
      ? implementation.inputExtensionSchema
      : implementation.outputExtensionSchema,
  );
}

function materializeTool(
  contract: CapabilityToolContract,
  manifest: ProviderManifest,
  implementation: ProviderToolImplementation,
): ToolDefinition {
  const name = validateCanonicalToolName(
    `${manifest.toolkit.slug}.${contract.name}`,
  );
  const inputSchema = materializeSchema(
    contract.inputSchema,
    implementation,
    manifest.toolkit.slug,
    "input",
  );
  const outputSchema =
    contract.outputSchema === undefined
      ? undefined
      : materializeSchema(
          contract.outputSchema,
          implementation,
          manifest.toolkit.slug,
          "output",
        );

  return deepFreeze({
    name,
    toolkit: manifest.toolkit.slug,
    capability: contract.capability,
    description: contract.description,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: clone(contract.annotations),
    version: contract.version,
  });
}

/**
 * Mutable catalog builder with immutable lookup results. Register capability contracts
 * before the manifests that implement them.
 */
export class CatalogRegistry {
  readonly catalogVersion: CatalogVersion;
  readonly #contracts = new Map<string, CapabilityToolContract>();
  readonly #manifests = new Map<string, ProviderManifest>();

  constructor(options: CatalogRegistryOptions = {}) {
    const catalogVersion = options.catalogVersion ?? "1.0";
    assertCatalogVersion(catalogVersion, "Catalog registry");
    this.catalogVersion = catalogVersion;
    this.registerContracts(options.contracts ?? []);
    for (const manifest of options.manifests ?? []) {
      this.registerManifest(manifest);
    }
  }

  registerContract(contract: CapabilityToolContract): this {
    return this.registerContracts([contract]);
  }

  registerContracts(contracts: readonly CapabilityToolContract[]): this {
    const pending = new Map<string, CapabilityToolContract>();

    for (const contract of contracts) {
      assertContract(contract);
      if (
        this.catalogVersion === "1.0" &&
        !getCapabilityCatalogEntry(contract.capability)?.tools.some(
          ({ name }) => name === contract.name,
        )
      ) {
        throw new Error(
          `Contract ${contract.capability}.${contract.name} is not present in catalog 1.0.`,
        );
      }
      const key = contractKey(
        contract.capability,
        contract.name,
        contract.version,
      );
      if (this.#contracts.has(key) || pending.has(key)) {
        throw new Error(
          `Duplicate capability contract: ${contract.capability}.${contract.name}@${contract.version}`,
        );
      }
      pending.set(key, clone(contract));
    }

    for (const [key, contract] of pending) {
      this.#contracts.set(key, contract);
    }
    return this;
  }

  registerCapability(contracts: readonly CapabilityToolContract[]): this {
    const capability = contracts[0]?.capability;
    if (capability === undefined) {
      throw new Error(
        "A capability registration must include at least one contract.",
      );
    }
    if (contracts.some((contract) => contract.capability !== capability)) {
      throw new Error(
        "A capability registration may only contain contracts from one capability.",
      );
    }
    return this.registerContracts(contracts);
  }

  registerManifest(manifest: ProviderManifest): this {
    assertManifestHeader(manifest, this.catalogVersion);
    if (this.catalogVersion === "1.0") {
      assertCatalogProviderIdentity(manifest);
    }
    if (this.#manifests.has(manifest.toolkit.slug)) {
      throw new Error(`Duplicate provider manifest: ${manifest.toolkit.slug}`);
    }

    const implementations = new Set<string>();
    const qualifiedNames = new Set<string>();
    for (const implementation of manifest.implements) {
      assertCapability(
        implementation.capability,
        `Manifest ${manifest.toolkit.slug}`,
      );
      assertSemVer(
        implementation.canonicalVersion,
        `Manifest ${manifest.toolkit.slug} implementation ${implementation.canonicalTool}`,
      );
      validateCanonicalToolName(
        `${manifest.toolkit.slug}.${implementation.canonicalTool}`,
      );
      assertNonEmpty(
        implementation.operationId,
        `Operation ID for ${manifest.toolkit.slug}.${implementation.canonicalTool}`,
      );
      assertStringList(
        implementation.requiredScopes,
        `Required scopes for ${manifest.toolkit.slug}.${implementation.canonicalTool}`,
      );
      if (
        this.catalogVersion === "1.0" &&
        !getProviderCatalogEntry(manifest.toolkit.slug)?.memberships.some(
          ({ capability }) => capability === implementation.capability,
        )
      ) {
        throw new Error(
          `Manifest ${manifest.toolkit.slug} is not cataloged for capability ${implementation.capability}.`,
        );
      }

      const key = implementationKey(implementation);
      if (implementations.has(key)) {
        throw new Error(
          `Manifest ${manifest.toolkit.slug} declares duplicate tool ${implementation.canonicalTool}.`,
        );
      }
      implementations.add(key);
      const qualifiedName = `${manifest.toolkit.slug}.${implementation.canonicalTool}`;
      if (qualifiedNames.has(qualifiedName)) {
        throw new Error(
          `Manifest ${manifest.toolkit.slug} declares colliding qualified tool ${qualifiedName}.`,
        );
      }
      qualifiedNames.add(qualifiedName);

      const contract = this.#contracts.get(key);
      if (contract === undefined) {
        throw new Error(
          `Manifest ${manifest.toolkit.slug} references unknown contract ${implementation.capability}.${implementation.canonicalTool}@${implementation.canonicalVersion}.`,
        );
      }

      if (implementation.inputExtensionSchema !== undefined) {
        assertExtensionSchema(
          implementation.inputExtensionSchema,
          `Input extension for ${manifest.toolkit.slug}.${implementation.canonicalTool}`,
        );
      }
      if (implementation.outputExtensionSchema !== undefined) {
        if (contract.outputSchema === undefined) {
          throw new Error(
            `Output extension for ${manifest.toolkit.slug}.${implementation.canonicalTool} requires a canonical output schema.`,
          );
        }
        assertExtensionSchema(
          implementation.outputExtensionSchema,
          `Output extension for ${manifest.toolkit.slug}.${implementation.canonicalTool}`,
        );
      }

      const materialized = materializeTool(contract, manifest, implementation);
      assertSchema(
        materialized.inputSchema,
        `Materialized input schema for ${materialized.name}`,
      );
      if (materialized.outputSchema !== undefined) {
        assertSchema(
          materialized.outputSchema,
          `Materialized output schema for ${materialized.name}`,
        );
      }
    }

    this.#manifests.set(manifest.toolkit.slug, clone(manifest));
    return this;
  }

  getTool(name: string): ToolDefinition | undefined {
    if (!isCanonicalToolName(name)) {
      return undefined;
    }

    const separator = name.indexOf(".");
    const toolkit = name.slice(0, separator);
    const canonicalTool = name.slice(separator + 1);
    const manifest = this.#manifests.get(toolkit);
    if (manifest === undefined) {
      return undefined;
    }

    const implementation = manifest.implements.find(
      (candidate) => candidate.canonicalTool === canonicalTool,
    );
    if (implementation === undefined) {
      return undefined;
    }

    const contract = this.#contracts.get(implementationKey(implementation));
    if (contract === undefined) {
      return undefined;
    }
    return materializeTool(contract, manifest, implementation);
  }

  getEffectiveScopes(name: string): EffectiveScopes | undefined {
    if (!isCanonicalToolName(name)) {
      return undefined;
    }

    const separator = name.indexOf(".");
    const toolkit = name.slice(0, separator);
    const canonicalTool = name.slice(separator + 1);
    const manifest = this.#manifests.get(toolkit);
    const implementation = manifest?.implements.find(
      (candidate) => candidate.canonicalTool === canonicalTool,
    );
    if (manifest === undefined || implementation === undefined) {
      return undefined;
    }

    const required = new Set([
      ...(manifest.auth.requiredScopes ?? []),
      ...(implementation.requiredScopes ?? []),
    ]);
    const optional = new Set(
      (manifest.auth.optionalScopes ?? []).filter(
        (scope) => !required.has(scope),
      ),
    );
    return {
      required: Object.freeze([...required].sort()),
      optional: Object.freeze([...optional].sort()),
    };
  }

  listTools(filters: ListToolsFilters = {}): readonly ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    for (const manifest of this.#manifests.values()) {
      if (
        (filters.toolkit !== undefined &&
          manifest.toolkit.slug !== filters.toolkit) ||
        (filters.tier !== undefined && manifest.toolkit.tier !== filters.tier)
      ) {
        continue;
      }

      for (const implementation of manifest.implements) {
        if (
          filters.capability !== undefined &&
          implementation.capability !== filters.capability
        ) {
          continue;
        }
        const contract = this.#contracts.get(implementationKey(implementation));
        if (contract !== undefined) {
          tools.push(materializeTool(contract, manifest, implementation));
        }
      }
    }

    return tools.sort((left, right) => left.name.localeCompare(right.name));
  }

  listContracts(
    filters: ListContractsFilters = {},
  ): readonly CapabilityToolContract[] {
    return [...this.#contracts.values()]
      .filter(
        (contract) =>
          (filters.capability === undefined ||
            contract.capability === filters.capability) &&
          (filters.name === undefined || contract.name === filters.name) &&
          (filters.version === undefined ||
            contract.version === filters.version),
      )
      .map(clone)
      .sort((left, right) =>
        `${left.capability}.${left.name}@${left.version}`.localeCompare(
          `${right.capability}.${right.name}@${right.version}`,
        ),
      );
  }

  listManifests(
    filters: ListManifestsFilters = {},
  ): readonly ProviderManifest[] {
    return [...this.#manifests.values()]
      .filter(
        (manifest) =>
          (filters.tier === undefined ||
            manifest.toolkit.tier === filters.tier) &&
          (filters.capability === undefined ||
            manifest.implements.some(
              ({ capability }) => capability === filters.capability,
            )),
      )
      .map(clone)
      .sort((left, right) =>
        left.toolkit.slug.localeCompare(right.toolkit.slug),
      );
  }

  listToolkits(): readonly Toolkit[] {
    return [...this.#manifests.values()]
      .map(({ toolkit }) => clone(toolkit))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  getManifest(slug: string): ProviderManifest | undefined {
    const manifest = this.#manifests.get(slug);
    return manifest === undefined ? undefined : clone(manifest);
  }

  toCatalogManifest(generatedAt: string): CatalogManifest {
    const parsed = new Date(generatedAt);
    if (
      Number.isNaN(parsed.valueOf()) ||
      parsed.toISOString() !== generatedAt
    ) {
      throw new Error(
        "Catalog generatedAt must be an RFC 3339 UTC timestamp with millisecond precision.",
      );
    }

    return {
      catalogVersion: this.catalogVersion,
      generatedAt,
      tools: this.listTools(),
      providers: this.listManifests(),
    };
  }
}
