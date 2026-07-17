import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCatalog } from "../packages/catalog/src/default.js";
import type {
  JSONSchema202012,
  JsonValue,
  ObjectSchema202012,
  ProviderManifest,
  ToolDefinition,
} from "../packages/core/src/index.js";
import { validateInput } from "../packages/core/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(repositoryRoot, "docs-site");
const generatedRoot = join(docsRoot, "toolkits", "generated");

const capabilityLabels: Readonly<Record<string, string>> = {
  calendar_scheduling: "Calendar and scheduling",
  crm: "CRM",
  customer_support: "Customer support",
  ecommerce: "E-commerce",
  email: "Email",
  erp_accounting: "ERP and accounting",
  file_storage_docs: "Files and documents",
  messaging_chat: "Messaging and chat",
  payments_billing: "Payments and billing",
  project_management_dev_tools: "Project and developer tools",
  social_media_data: "Social media data",
  spreadsheets_databases: "Spreadsheets and databases",
  voice_telephony: "Voice and telephony",
};

const capabilityOrder = [
  "email",
  "calendar_scheduling",
  "messaging_chat",
  "voice_telephony",
  "crm",
  "erp_accounting",
  "payments_billing",
  "ecommerce",
  "customer_support",
  "social_media_data",
  "file_storage_docs",
  "spreadsheets_databases",
  "project_management_dev_tools",
] as const;

interface NavigationGroup {
  group: string;
  pages: (string | NavigationGroup)[];
}

interface DocsConfig {
  navigation: NavigationGroup[];
  [key: string]: unknown;
}

function codeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function referencedSchema(
  schema: JSONSchema202012,
  root: ObjectSchema202012,
): JSONSchema202012 {
  if (
    schema !== true &&
    schema !== false &&
    schema.$ref?.startsWith("#/$defs/")
  ) {
    const name = schema.$ref.slice("#/$defs/".length);
    return root.$defs?.[name] ?? schema;
  }
  return schema;
}

function minimalValue(
  initial: JSONSchema202012 | undefined,
  root: ObjectSchema202012,
  propertyName = "value",
  depth = 0,
): JsonValue {
  if (initial === undefined || initial === true || depth > 12) {
    return null;
  }
  if (initial === false) {
    return null;
  }
  const schema = referencedSchema(initial, root);
  if (schema === true || schema === false) {
    return null;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (schema.default !== undefined) {
    return schema.default;
  }
  if (schema.enum?.[0] !== undefined) {
    return schema.enum[0];
  }
  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch !== undefined) {
    return minimalValue(branch, root, propertyName, depth + 1);
  }
  if (schema.type === "object" || schema.properties !== undefined) {
    const result: Record<string, JsonValue> = {};
    for (const required of schema.required ?? []) {
      result[required] = minimalValue(
        schema.properties?.[required],
        root,
        required,
        depth + 1,
      );
    }
    return result;
  }
  if (schema.type === "array") {
    return (schema.minItems ?? 0) > 0
      ? [minimalValue(schema.items, root, propertyName, depth + 1)]
      : [];
  }
  if (schema.type === "boolean") {
    return false;
  }
  if (schema.type === "integer" || schema.type === "number") {
    return schema.minimum ?? 1;
  }
  if (schema.type === "null") {
    return null;
  }
  if (schema.format === "email") {
    return "demo@example.com";
  }
  if (schema.format === "date") {
    return "2026-07-17";
  }
  if (schema.format === "date-time") {
    return "2026-07-17T12:00:00.000Z";
  }
  if (schema.format === "uri") {
    return "https://example.com/resource";
  }
  if (schema.format === "uuid") {
    return "00000000-0000-4000-8000-000000000001";
  }
  if (schema.pattern?.includes("\\+")) {
    return "+12025550123";
  }
  if (/^(to|from|phoneNumber)$/iu.test(propertyName)) {
    return "+12025550123";
  }
  if (/email/iu.test(propertyName)) {
    return "demo@example.com";
  }
  if (/timeZone/iu.test(propertyName)) {
    return "UTC";
  }
  if (/^(start|end)$/iu.test(propertyName)) {
    return propertyName === "start" ? "09:00" : "17:00";
  }
  return `example_${propertyName}`;
}

function minimalInput(
  tool: ToolDefinition,
): Readonly<Record<string, JsonValue>> {
  const result = minimalValue(tool.inputSchema, tool.inputSchema);
  const input =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Readonly<Record<string, JsonValue>>)
      : {};
  const validated = validateInput(tool, input);
  if (!validated.ok) {
    throw new Error(
      `Generated input for ${tool.name} does not satisfy its schema: ${JSON.stringify(validated.errors)}`,
    );
  }
  return validated.value;
}

function sdkExample(tool: ToolDefinition): string {
  const mutationOption = tool.annotations.readOnly
    ? ""
    : `,\n  idempotencyKey: "docs:${tool.name}:demo-1"`;
  return `import { Eyeball } from "@eyeball/sdk";\n\nconst eyeball = new Eyeball({\n  apiKey: process.env.EYEBALL_API_KEY!,\n  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,\n});\n\nconst output = await eyeball.tools.run(\n  "${tool.name}",\n  ${codeJson(minimalInput(tool))},\n  { userId: "demo_user"${mutationOption} },\n);\nconsole.log(output);`;
}

function curlExample(tool: ToolDefinition): string {
  const parts = [
    `curl "$EYEBALL_EXECUTOR_URL/v1/execute"`,
    `-H "Authorization: Bearer $EYEBALL_API_KEY"`,
    "-H 'Content-Type: application/json'",
  ];
  if (!tool.annotations.readOnly) {
    parts.push(`-H 'Idempotency-Key: docs:${tool.name}:demo-1'`);
  }
  parts.push(
    `--data '${JSON.stringify({
      tool: tool.name,
      userId: "demo_user",
      input: minimalInput(tool),
      mode: tool.annotations.async ? "async" : "sync",
    })}'`,
  );
  return parts.join(" \\" + "\n  ");
}

function extensionText(manifest: ProviderManifest): string {
  const rows = manifest.implements.flatMap((implementation) => {
    const directions: string[] = [];
    if (implementation.inputExtensionSchema !== undefined) {
      directions.push(
        `### \`${manifest.toolkit.slug}.${implementation.canonicalTool}\` input\n\n\`input.x_provider.${manifest.toolkit.slug}\` accepts:\n\n\`\`\`json\n${codeJson(implementation.inputExtensionSchema)}\n\`\`\``,
      );
    }
    if (implementation.outputExtensionSchema !== undefined) {
      directions.push(
        `### \`${manifest.toolkit.slug}.${implementation.canonicalTool}\` output\n\n\`output.x_provider.${manifest.toolkit.slug}\` may return:\n\n\`\`\`json\n${codeJson(implementation.outputExtensionSchema)}\n\`\`\``,
      );
    }
    return directions;
  });
  return rows.length === 0
    ? "This manifest declares no provider-specific schema extensions. Use only canonical fields."
    : rows.join("\n\n");
}

function toolkitPage(
  manifest: ProviderManifest,
  tools: readonly ToolDefinition[],
  checksum: string,
): string {
  const first = tools[0];
  if (first === undefined) {
    throw new Error(
      `Toolkit ${manifest.toolkit.slug} has no materialized tools.`,
    );
  }
  const toolRows = tools
    .map(
      (tool) =>
        `| \`${tool.name}\` | ${markdownCell(tool.description)} | ${tool.annotations.async ? "async" : "sync or async"} | ${tool.annotations.readOnly ? "read" : tool.annotations.destructive ? "destructive mutation" : "mutation"} | \`${tool.version}\` |`,
    )
    .join("\n");
  const schemaBlocks = tools
    .map(
      (tool) =>
        `<Accordion title="${tool.name}">\n\n**Input schema**\n\n\`\`\`json\n${codeJson(tool.inputSchema)}\n\`\`\`\n\n**Output schema**\n\n\`\`\`json\n${codeJson(tool.outputSchema ?? { type: "object" })}\n\`\`\`\n\n</Accordion>`,
    )
    .join("\n\n");
  const effectiveScopes = tools
    .flatMap(
      (tool) => defaultCatalog.getEffectiveScopes(tool.name)?.required ?? [],
    )
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index)
    .sort();
  const optionalScopes = manifest.auth.optionalScopes ?? [];
  const fields = manifest.auth.fields ?? [];
  const asyncTools = tools.filter((tool) => tool.annotations.async);
  const manifestCapabilities = [
    ...new Set(manifest.implements.map(({ capability }) => capability)),
  ];

  return `---
title: ${JSON.stringify(manifest.toolkit.displayName)}
description: ${JSON.stringify(`Canonical tools, auth, schemas, and mock behavior for ${manifest.toolkit.displayName}.`)}
---

<!-- DO NOT EDIT: generated by pnpm docs:generate; catalog checksum ${checksum}. -->

Run a valid \`${first.name}\` call through the same SDK surface used by every toolkit.

## Minimal tool call

\`\`\`ts
${sdkExample(first)}
\`\`\`

The model receives canonical output. Your application retains the execution envelope through \`tools.execute\` or the execution APIs when it needs IDs, status, versions, and latency.

## Supported canonical tools

| Tool | Purpose | Execution | Effect | Version |
|---|---|---|---|---|
${toolRows}

Only the rows above are implemented. A capability tool omitted by this manifest returns \`not_supported\`; eyeball never synthesizes provider parity.

## Input and output schemas

${schemaBlocks}

## Authentication

| Property | Value |
|---|---|
| Auth class | \`${manifest.auth.class}\` |
| Required scopes | ${effectiveScopes.length === 0 ? "None" : effectiveScopes.map((scope) => `\`${scope}\``).join("<br />")} |
| Optional scopes | ${optionalScopes.length === 0 ? "None" : optionalScopes.map((scope) => `\`${scope}\``).join("<br />")} |
| Credential fields | ${fields.length === 0 ? "None" : fields.map((field) => `\`${field}\``).join(", ")} |

Credentials are resolved inside the executor by \`CredentialProvider\`. They never belong in tool input, \`x_provider\`, model context, logs, or execution output.

## Provider-specific extensions

${extensionText(manifest)}

Provider differences may appear only under \`x_provider.${manifest.toolkit.slug}\` and only when the schema above declares them.

## Sync and async behavior

${asyncTools.length === 0 ? 'All tools are synchronous by nature, but callers may choose `mode: "async"` to queue them.' : `These tools require async mode: ${asyncTools.map((tool) => `\`${tool.name}\``).join(", ")}. Other tools accept sync or async mode.`}

Mutations require a stable \`Idempotency-Key\`. The TypeScript SDK accepts it as \`idempotencyKey\`; it is never part of the JSON request body.

## REST example

\`\`\`bash
${curlExample(first)}
\`\`\`

## Mock support

Point \`EYEBALL_EXECUTOR_URL\` at a mock-configured executor to run through the real catalog, validation, credential seam, adapter, normalized errors, and execution records with no ${manifest.toolkit.displayName} account. Mock selection changes the executor endpoint and trusted provider base-URL configuration, never the execute request.

## Limitations

- This page describes the manifest's explicit ${manifest.toolkit.tier} subset, not every operation offered by the provider.
- Provider account policy, consent UI, quota details, and current wire compatibility still require a real-provider certification pass.
- Fields outside the canonical schemas and declared \`x_provider\` extensions are rejected.

## Versions

| Contract | Version |
|---|---|
| Runtime catalog | \`${defaultCatalog.catalogVersion}\` |
| Manifest catalog | \`${manifest.catalogVersion}\` |
| Manifest schema | \`${manifest.schemaVersion}\` |
| Source | \`${manifest.toolkit.source}\` |
| Tier | \`${manifest.toolkit.tier}\` |
| Capabilities | ${manifestCapabilities.map((capability) => `\`${capability}\``).join(", ")} |

## Next

Use [Testing with mocks](/mocks/quickstart) to exercise this toolkit before connecting a live provider account.
`;
}

async function writeDeterministic(
  path: string,
  content: string,
): Promise<void> {
  let previous: string | undefined;
  try {
    previous = await readFile(path, "utf8");
  } catch {
    previous = undefined;
  }
  if (previous !== content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

async function main(): Promise<void> {
  const manifests = defaultCatalog.listManifests();
  if (manifests.length !== 37) {
    throw new Error(
      `Expected 37 toolkit manifests, received ${manifests.length}.`,
    );
  }
  const checksum = createHash("sha256")
    .update(
      JSON.stringify({
        catalogVersion: defaultCatalog.catalogVersion,
        manifests,
        tools: defaultCatalog.listTools(),
      }),
    )
    .digest("hex")
    .slice(0, 16);

  const grouped = new Map<string, string[]>();
  const generatedPages = new Set<string>();
  for (const manifest of manifests) {
    const tools = defaultCatalog.listTools({ toolkit: manifest.toolkit.slug });
    const filename = `${manifest.toolkit.slug}.mdx`;
    generatedPages.add(filename);
    await writeDeterministic(
      join(generatedRoot, filename),
      toolkitPage(manifest, tools, checksum),
    );
    const capability = capabilityOrder.find((candidate) =>
      manifest.implements.some((item) => item.capability === candidate),
    );
    if (capability === undefined) {
      throw new Error(
        `Toolkit ${manifest.toolkit.slug} has no documented capability group.`,
      );
    }
    const pages = grouped.get(capability) ?? [];
    pages.push(`toolkits/generated/${manifest.toolkit.slug}`);
    grouped.set(capability, pages);
  }

  for (const entry of await readdir(generatedRoot, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".mdx") ||
      generatedPages.has(entry.name)
    ) {
      continue;
    }
    const stalePath = join(generatedRoot, entry.name);
    const source = await readFile(stalePath, "utf8");
    if (!source.includes("DO NOT EDIT")) {
      throw new Error(`Refusing to remove non-generated page ${stalePath}.`);
    }
    await unlink(stalePath);
  }

  const fragment: NavigationGroup[] = capabilityOrder.flatMap((capability) => {
    const pages = grouped.get(capability);
    return pages === undefined
      ? []
      : [
          {
            group: capabilityLabels[capability] ?? capability,
            pages: pages.sort(),
          },
        ];
  });
  await writeDeterministic(
    join(generatedRoot, "navigation.json"),
    `${codeJson(fragment)}\n`,
  );

  const docsPath = join(docsRoot, "docs.json");
  const docs = JSON.parse(await readFile(docsPath, "utf8")) as DocsConfig;
  const toolkitNavigation = docs.navigation.find(
    (group) => group.group === "Toolkit Reference",
  );
  if (toolkitNavigation === undefined) {
    throw new Error("docs.json is missing the Toolkit Reference group.");
  }
  toolkitNavigation.pages = [
    "toolkits/index",
    "toolkits/choose-a-toolkit",
    ...fragment,
  ];
  await writeDeterministic(docsPath, `${codeJson(docs)}\n`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
