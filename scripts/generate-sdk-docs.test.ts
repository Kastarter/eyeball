import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSdkReference, generateSdkDocs } from "./generate-sdk-docs.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(): Promise<{
  root: string;
  generatedRoot: string;
  docsConfigPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "eyeball-sdk-docs-"));
  const docsConfigPath = join(root, "docs.json");
  await writeFile(
    docsConfigPath,
    `${JSON.stringify({
      navigation: [{ group: "SDK Reference", pages: [] }],
    })}\n`,
    "utf8",
  );
  return {
    root,
    generatedRoot: join(root, "generated"),
    docsConfigPath,
  };
}

async function generatedBytes(
  generatedRoot: string,
  docsConfigPath: string,
): Promise<Readonly<Record<string, string>>> {
  const filenames = (await readdir(generatedRoot)).sort();
  const entries = await Promise.all(
    filenames.map(async (filename) => [
      filename,
      await readFile(join(generatedRoot, filename), "utf8"),
    ]),
  );
  entries.push(["docs.json", await readFile(docsConfigPath, "utf8")]);
  return Object.fromEntries(entries);
}

describe("generated SDK reference", () => {
  it("writes identical bytes across consecutive generations", async () => {
    const paths = await fixture();
    try {
      await generateSdkDocs({
        repositoryRoot,
        generatedRoot: paths.generatedRoot,
        docsConfigPath: paths.docsConfigPath,
      });
      const first = await generatedBytes(
        paths.generatedRoot,
        paths.docsConfigPath,
      );
      await generateSdkDocs({
        repositoryRoot,
        generatedRoot: paths.generatedRoot,
        docsConfigPath: paths.docsConfigPath,
      });
      expect(
        await generatedBytes(paths.generatedRoot, paths.docsConfigPath),
      ).toEqual(first);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("extracts tools.get parameters and its TSDoc example", () => {
    const reference = buildSdkReference(repositoryRoot);
    const tools = reference.pages.get("tools.mdx");
    expect(tools).toContain("### `get`");
    expect(tools).toContain(
      "| `options` | <code>GetToolsOptions&lt;Format&gt;</code> | No |",
    );
    expect(tools).toContain(
      'const bundle = await eyeball.tools.get({\n  toolkits: ["gmail"],',
    );
  });

  it("assigns bounded execution provenance types and field documentation", () => {
    const reference = buildSdkReference(repositoryRoot);
    const executions = reference.pages.get("executions.mdx");
    expect(executions).toContain("ExecutionAttachmentSummary");
    expect(executions).toContain("ExecutionSource");
    expect(executions).toContain("replayed");
    expect(executions).toContain("attachments");
    expect(executions).toContain("voice_session");
    expect(executions).toContain("Accepted replay observed");
    expect(executions).toContain("never includes canonical input");
  });

  it("assigns redacted trigger history and renders its runnable example", () => {
    const reference = buildSdkReference(repositoryRoot);
    const triggerEvents = reference.pages.get("trigger-events.mdx");
    expect(triggerEvents).toContain("TriggerEventsClient");
    expect(triggerEvents).toContain("### `list`");
    expect(triggerEvents).toContain("metadata-only");
    expect(triggerEvents).toContain("TriggerEventDeliveryStatus");
    expect(triggerEvents).toContain(
      'trigger: "slack.message_received",\n  limit: 50,',
    );
  });

  it("rejects a stale generated checksum without touching the repository", async () => {
    const paths = await fixture();
    try {
      const reference = await generateSdkDocs({
        repositoryRoot,
        generatedRoot: paths.generatedRoot,
        docsConfigPath: paths.docsConfigPath,
      });
      const toolsPath = join(paths.generatedRoot, "tools.mdx");
      const source = await readFile(toolsPath, "utf8");
      await writeFile(
        toolsPath,
        source.replace(reference.checksum, "0000000000000000"),
        "utf8",
      );

      await expect(
        generateSdkDocs({
          repositoryRoot,
          generatedRoot: paths.generatedRoot,
          docsConfigPath: paths.docsConfigPath,
          check: true,
        }),
      ).rejects.toThrow("generated/tools.mdx is stale; run pnpm docs:sdk");
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});
