import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertPublishableVersionsAgree,
  publishablePackageDirectories,
  readPublishableVersions,
} from "./stamp-version.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  description?: string;
  type?: string;
  files?: string[];
  main?: string;
  types?: string;
  exports?: unknown;
  license?: string;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
  homepage?: string;
  engines?: { node?: string };
  sideEffects?: boolean;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
}

const publishable = [
  { directory: "packages/core", name: "@eyeball/core", dependencies: [] },
  {
    directory: "packages/catalog",
    name: "@eyeball/catalog",
    dependencies: ["@eyeball/core"],
  },
  {
    directory: "packages/toolkits",
    name: "@eyeball/toolkits",
    dependencies: ["@eyeball/core"],
  },
  {
    directory: "packages/sdk",
    name: "@eyeball/sdk",
    dependencies: ["@eyeball/catalog", "@eyeball/core"],
  },
] as const;

const privateWorkspaces = [
  { directory: "packages/bridge", name: "@eyeball/bridge" },
  { directory: "apps/dashboard", name: "@eyeball/dashboard" },
  { directory: "apps/docs", name: "@eyeball/docs" },
  { directory: "apps/executor", name: "@eyeball/executor" },
  { directory: "apps/mcp-gateway", name: "@eyeball/mcp-gateway" },
] as const;

function readManifest(directory: string): Manifest {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, directory, "package.json"), "utf8"),
  ) as Manifest;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap(exportTargets);
}

describe("release workspace boundary", () => {
  it("publishes exactly four packages and keeps every app plus the bridge private", () => {
    expect(publishable.map(({ directory }) => directory)).toEqual(
      publishablePackageDirectories,
    );
    expect([...publishable, ...privateWorkspaces]).toHaveLength(9);

    for (const expected of publishable) {
      const manifest = readManifest(expected.directory);
      expect(manifest.name).toBe(expected.name);
      expect(manifest.private).toBe(false);
    }

    for (const expected of privateWorkspaces) {
      const manifest = readManifest(expected.directory);
      expect(manifest.name).toBe(expected.name);
      expect(manifest.private).toBe(true);
    }
  });

  it("hardens every public package manifest for an ESM npm release", () => {
    const rootLicense = readFileSync(
      resolve(repositoryRoot, "LICENSE.md"),
      "utf8",
    );
    for (const expected of publishable) {
      const manifest = readManifest(expected.directory);
      expect(manifest.description).toBeTruthy();
      expect(manifest.type).toBe("module");
      expect(manifest.files).toEqual(["dist", "README.md", "LICENSE.md"]);
      expect(manifest.license).toBe("SEE LICENSE IN LICENSE.md");
      expect(manifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/eyeball-ai/eyeball.git",
        directory: expected.directory,
      });
      expect(manifest.homepage).toBe(
        "https://github.com/eyeball-ai/eyeball#readme",
      );
      expect(manifest.engines?.node).toBe(">=20");
      expect(manifest.sideEffects).toBe(false);
      expect(manifest.publishConfig?.access).toBe("public");

      for (const includedFile of ["README.md", "LICENSE.md"]) {
        expect(
          existsSync(resolve(repositoryRoot, expected.directory, includedFile)),
        ).toBe(true);
      }
      expect(
        readFileSync(
          resolve(repositoryRoot, expected.directory, "LICENSE.md"),
          "utf8",
        ),
      ).toBe(rootLicense);
    }
  });

  it("resolves main, types, and export targets to built dist files", () => {
    for (const expected of publishable) {
      const manifest = readManifest(expected.directory);
      const targets = [
        manifest.main,
        manifest.types,
        ...exportTargets(manifest.exports),
      ];
      expect(targets.length).toBeGreaterThanOrEqual(4);

      for (const target of targets) {
        expect(target).toMatch(/^\.\/dist\//);
        expect(
          existsSync(resolve(repositoryRoot, expected.directory, target ?? "")),
        ).toBe(true);
      }
    }
  });

  it("uses publish-rewritable workspace ranges for internal dependencies", () => {
    for (const expected of publishable) {
      const dependencies = readManifest(expected.directory).dependencies ?? {};
      const internalDependencies = Object.entries(dependencies)
        .filter(([name]) => name.startsWith("@eyeball/"))
        .sort(([left], [right]) => left.localeCompare(right));
      expect(internalDependencies.map(([name]) => name)).toEqual(
        [...expected.dependencies].sort(),
      );
      for (const [, range] of internalDependencies) {
        expect(range).toBe("workspace:*");
      }
    }
  });

  it("keeps Changesets fixed to the public package boundary", () => {
    const config = JSON.parse(
      readFileSync(resolve(repositoryRoot, ".changeset/config.json"), "utf8"),
    ) as {
      access?: string;
      fixed?: string[][];
      ignore?: string[];
    };

    expect(config.access).toBe("public");
    expect(config.fixed).toEqual([publishable.map(({ name }) => name)]);
    expect(new Set(config.ignore)).toEqual(
      new Set(privateWorkspaces.map(({ name }) => name)),
    );
  });
});

describe("release version stamping", () => {
  it("requires all four public packages to share one valid version", async () => {
    const packages = await readPublishableVersions(repositoryRoot);
    expect(assertPublishableVersionsAgree(packages)).toBe(packages[0]?.version);
  });
});
