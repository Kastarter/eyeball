import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const publishablePackageDirectories = [
  "packages/core",
  "packages/catalog",
  "packages/toolkits",
  "packages/sdk",
] as const;

export interface PackageVersion {
  directory: (typeof publishablePackageDirectories)[number];
  name: string;
  version: string;
}

const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function readPublishableVersions(
  repositoryRoot = defaultRepositoryRoot,
): Promise<PackageVersion[]> {
  return Promise.all(
    publishablePackageDirectories.map(async (directory) => {
      const packageJsonPath = resolve(
        repositoryRoot,
        directory,
        "package.json",
      );
      const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };

      if (
        typeof manifest.name !== "string" ||
        typeof manifest.version !== "string"
      ) {
        throw new Error(
          `${directory}/package.json must declare a name and version.`,
        );
      }

      return { directory, name: manifest.name, version: manifest.version };
    }),
  );
}

export function assertPublishableVersionsAgree(
  packages: readonly PackageVersion[],
): string {
  if (packages.length !== publishablePackageDirectories.length) {
    throw new Error(
      `Expected ${publishablePackageDirectories.length} publishable packages, received ${packages.length}.`,
    );
  }

  const versions = new Set(
    packages.map((packageVersion) => packageVersion.version),
  );
  if (versions.size !== 1) {
    const detail = packages
      .map(({ name, version }) => `${name}=${version}`)
      .join(", ");
    throw new Error(`Publishable package versions disagree: ${detail}`);
  }

  const [version] = versions;
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(
      `Invalid publishable package version: ${version ?? "missing"}.`,
    );
  }

  return version;
}

export async function checkPublishableVersions(
  repositoryRoot = defaultRepositoryRoot,
): Promise<string> {
  return assertPublishableVersionsAgree(
    await readPublishableVersions(repositoryRoot),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const unexpectedArguments = process.argv
    .slice(2)
    .filter((arg) => arg !== "--check");
  if (unexpectedArguments.length > 0) {
    console.error(`Unknown arguments: ${unexpectedArguments.join(" ")}`);
    process.exitCode = 1;
  } else {
    checkPublishableVersions()
      .then((version) => {
        console.log(`Publishable package versions agree at ${version}.`);
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
