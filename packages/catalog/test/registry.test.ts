import {
  type CapabilityToolContract,
  type ProviderManifest,
  validateInput,
} from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  CatalogRegistry,
  emailCapabilityContracts,
  emailContractsByName,
  gmailManifest,
} from "../src/index.js";

function cloneManifest(): ProviderManifest {
  return structuredClone(gmailManifest) as ProviderManifest;
}

function createRegistry(): CatalogRegistry {
  return new CatalogRegistry({
    contracts: emailCapabilityContracts,
    manifests: [gmailManifest],
  });
}

function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected test fixture value to be defined.");
  }
  return value;
}

describe("catalog registry materialization", () => {
  it("materializes the RFC Gmail tool without changing canonical fields", () => {
    const tool = createRegistry().getTool("gmail.send_email");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      name: "gmail.send_email",
      toolkit: "gmail",
      capability: "email",
      description: emailContractsByName.send_email.description,
      annotations: emailContractsByName.send_email.annotations,
      version: "1.0.0",
    });
    expect(tool?.inputSchema.$id).toBe(
      "urn:eyeball:email:send_email:1.0.0:gmail",
    );
    expect(tool?.outputSchema?.$id).toBe(
      "urn:eyeball:email:send_email:output:1.0.0:gmail",
    );
    expect(tool?.inputSchema.properties?.x_provider).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        gmail: gmailManifest.implements[0].inputExtensionSchema,
      },
    });
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool?.inputSchema.properties)).toBe(true);
  });

  it("accepts only the selected provider extension namespace", () => {
    const tool = defined(createRegistry().getTool("gmail.send_email"));
    expect(
      validateInput(tool, {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Body",
        x_provider: { gmail: { sendAs: "sender@example.com" } },
      }).ok,
    ).toBe(true);
    expect(
      validateInput(tool, {
        to: ["recipient@example.com"],
        subject: "Hello",
        body: "Body",
        x_provider: { slack: {} },
      }),
    ).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ keyword: "additionalProperties" })],
    });
  });

  it("treats manifest omission as authoritative", () => {
    const registry = createRegistry();
    expect(registry.listTools()).toHaveLength(8);
    expect(registry.getTool("gmail.send_email")).toBeDefined();
    expect(registry.getTool("gmail.nonexistent")).toBeUndefined();
    expect(registry.getTool("not a tool")).toBeUndefined();
  });

  it("filters contracts, tools, manifests, and toolkits deterministically", () => {
    const registry = createRegistry();
    expect(registry.listTools({ capability: "email" })).toHaveLength(8);
    expect(registry.listTools({ toolkit: "missing" })).toEqual([]);
    expect(registry.listTools({ tier: "P1" })).toEqual([]);
    expect(registry.listManifests({ capability: "email" })).toHaveLength(1);
    expect(registry.listManifests({ tier: "P1" })).toEqual([]);
    expect(registry.listToolkits()).toEqual([gmailManifest.toolkit]);
  });

  it("returns defensive copies and computes the effective scope union", () => {
    const manifest = cloneManifest();
    defined(manifest.implements[0]).requiredScopes = [
      "https://www.googleapis.com/auth/gmail.metadata",
    ];
    const registry = new CatalogRegistry({
      contracts: emailCapabilityContracts,
      manifests: [manifest],
    });

    const first = defined(registry.getManifest("gmail"));
    first.toolkit.displayName = "Changed by caller";
    expect(registry.getManifest("gmail")?.toolkit.displayName).toBe("Gmail");
    expect(registry.getEffectiveScopes("gmail.send_email")).toEqual({
      required: [
        "https://www.googleapis.com/auth/gmail.metadata",
        "https://www.googleapis.com/auth/gmail.modify",
      ],
      optional: ["https://www.googleapis.com/auth/gmail.send"],
    });
  });

  it("emits a versioned catalog manifest with stable ordering", () => {
    const manifest = createRegistry().toCatalogManifest(
      "2026-07-16T00:00:00.000Z",
    );
    expect(manifest).toMatchObject({
      catalogVersion: "1.0",
      generatedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(manifest.providers).toHaveLength(1);
    expect(manifest.tools).toHaveLength(8);
    expect(() => createRegistry().toCatalogManifest("2026-07-16")).toThrow(
      /generatedAt/,
    );
  });
});

describe("catalog registry build errors", () => {
  it("rejects catalog 1.0 metadata and contract drift", () => {
    const driftedManifest = cloneManifest();
    driftedManifest.toolkit.displayName = "Not Gmail";
    expect(
      () =>
        new CatalogRegistry({
          contracts: emailCapabilityContracts,
          manifests: [driftedManifest],
        }),
    ).toThrow(/disagrees with its catalog 1\.0 provider metadata/);

    const inventedContract = structuredClone(
      emailContractsByName.send_email,
    ) as CapabilityToolContract;
    inventedContract.name = "invented_tool";
    expect(
      () => new CatalogRegistry({ contracts: [inventedContract] }),
    ).toThrow(/not present in catalog 1\.0/);
  });

  it("rejects unknown contracts without partially registering a manifest", () => {
    const registry = new CatalogRegistry({
      contracts: emailCapabilityContracts,
    });
    const manifest = cloneManifest();
    manifest.implements = [
      {
        capability: "email",
        canonicalTool: "missing_tool",
        canonicalVersion: "1.0.0",
        operationId: "missing",
      },
    ];
    expect(() => registry.registerManifest(manifest)).toThrow(
      /unknown contract/,
    );
    expect(registry.listManifests()).toEqual([]);
  });

  it("rejects catalog-version mismatches and malformed endpoints", () => {
    const registry = new CatalogRegistry({
      contracts: emailCapabilityContracts,
    });
    const versionMismatch = cloneManifest();
    versionMismatch.catalogVersion = "2.0";
    expect(() => registry.registerManifest(versionMismatch)).toThrow(
      /targets catalog 2\.0/,
    );

    const malformedEndpoint = cloneManifest();
    malformedEndpoint.endpoint.baseUrl = "file:///etc/passwd";
    expect(() => registry.registerManifest(malformedEndpoint)).toThrow(
      /HTTP\(S\) base URL/,
    );
  });

  it("rejects duplicate, colliding, and output-less implementations", () => {
    const duplicate = cloneManifest();
    const implementation = defined(duplicate.implements[0]);
    duplicate.implements = [implementation, implementation];
    expect(
      () =>
        new CatalogRegistry({
          contracts: emailCapabilityContracts,
          manifests: [duplicate],
        }),
    ).toThrow(/duplicate tool/);

    const collidingContract = structuredClone(
      emailContractsByName.send_email,
    ) as CapabilityToolContract;
    collidingContract.capability = "crm";
    collidingContract.inputSchema.$id = "urn:eyeball:crm:send_email:1.0.0";
    if (collidingContract.outputSchema !== undefined) {
      collidingContract.outputSchema.$id =
        "urn:eyeball:crm:send_email:output:1.0.0";
    }
    const collision = cloneManifest();
    collision.catalogVersion = "1.1";
    collision.implements = [
      defined(collision.implements[0]),
      {
        capability: "crm",
        canonicalTool: "send_email",
        canonicalVersion: "1.0.0",
        operationId: "crm.send",
      },
    ];
    expect(
      () =>
        new CatalogRegistry({
          catalogVersion: "1.1",
          contracts: [emailContractsByName.send_email, collidingContract],
          manifests: [collision],
        }),
    ).toThrow(/colliding qualified tool/);

    const noOutput = structuredClone(
      emailContractsByName.send_email,
    ) as CapabilityToolContract;
    delete noOutput.outputSchema;
    const outputExtension = cloneManifest();
    outputExtension.implements = [
      {
        capability: "email",
        canonicalTool: "send_email",
        canonicalVersion: "1.0.0",
        operationId: "users.messages.send",
        outputExtensionSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
    ];
    expect(
      () =>
        new CatalogRegistry({
          contracts: [noOutput],
          manifests: [outputExtension],
        }),
    ).toThrow(/requires a canonical output schema/);
  });

  it("reserves x_provider for mechanical materialization", () => {
    const contract = structuredClone(
      emailContractsByName.send_email,
    ) as CapabilityToolContract;
    contract.name = "reserved_probe";
    contract.inputSchema.$id = "urn:eyeball:email:reserved_probe:1.0.0";
    contract.inputSchema.properties = {
      ...contract.inputSchema.properties,
      x_provider: { type: "object" },
    };
    expect(() => new CatalogRegistry({ contracts: [contract] })).toThrow(
      /reserved x_provider/,
    );
  });

  it("requires every RFC annotation", () => {
    const contract = structuredClone(
      emailContractsByName.send_email,
    ) as CapabilityToolContract;
    delete (contract.annotations as Partial<typeof contract.annotations>).async;
    expect(() => new CatalogRegistry({ contracts: [contract] })).toThrow(
      /exactly the four boolean annotations/,
    );
  });
});
