import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = new URL("../../../docs/PROVIDERS.md", import.meta.url);
const TARGET = new URL("../src/baseline.generated.ts", import.meta.url);

const CAPABILITY_SLUGS = [
  "email",
  "calendar_scheduling",
  "messaging_chat",
  "voice_telephony",
  "sms",
  "crm",
  "erp_accounting",
  "social_media_data",
  "social_media_publishing",
  "file_storage_docs",
  "spreadsheets_databases",
  "project_management_dev_tools",
  "payments_billing",
  "ecommerce",
  "customer_support",
  "web_search_scraping",
  "hr_recruiting",
  "marketing_ads",
  "sign_forms",
  "ai_media_utilities",
];

const EXPECTED = {
  capabilities: 20,
  contracts: 187,
  providers: 157,
  tiers: { P0: 34, P1: 72, P2: 51 },
};

const TOOLKIT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CANONICAL_TOOL_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(`Catalog generation failed: ${message}`);
}

function parseCatalog(markdown) {
  const lines = markdown.split(/\r?\n/);
  const focusByNumber = new Map();
  const capabilities = [];
  const capabilityNumbers = new Set();
  let current;
  let mode;

  for (const line of lines) {
    const taxonomy = line.match(/^\| (\d+) \| (.+?) \| (.+?) \|$/);
    if (taxonomy !== null) {
      focusByNumber.set(Number(taxonomy[1]), taxonomy[3]);
      continue;
    }

    const heading = line.match(/^## (\d+)\. (.+)$/);
    if (heading !== null) {
      const number = Number(heading[1]);
      const slug = CAPABILITY_SLUGS[number - 1];
      if (slug === undefined) fail(`unknown capability number ${number}`);
      if (capabilityNumbers.has(number)) {
        fail(`duplicate capability number ${number}`);
      }
      capabilityNumbers.add(number);
      current = {
        number,
        slug,
        displayName: heading[2],
        contractFocus: focusByNumber.get(number) ?? "",
        tools: [],
        providers: [],
      };
      capabilities.push(current);
      mode = undefined;
      continue;
    }

    if (line === "### Canonical tools") {
      mode = "tools";
      continue;
    }
    if (line === "### Providers") {
      mode = "providers";
      continue;
    }
    if (current === undefined || !line.startsWith("| `")) continue;

    if (mode === "tools") {
      const tool = line.match(/^\| `([^`]+)` \| (.+) \|$/);
      if (tool === null) fail(`cannot parse canonical tool row: ${line}`);
      if (!CANONICAL_TOOL_PATTERN.test(tool[1])) {
        fail(`invalid canonical tool name ${tool[1]} in ${current.slug}`);
      }
      if (current.tools.some(({ name }) => name === tool[1])) {
        fail(`duplicate canonical tool ${current.slug}.${tool[1]}`);
      }
      current.tools.push({ name: tool[1], description: tool[2] });
      continue;
    }

    if (mode === "providers") {
      const provider = line.match(
        /^\| `([^`]+)` — (.+?) \| (oauth2|api_key|basic|none) \| (activepieces-bridge|native|scrapecreators) \| (P[012]) \| (.+) \|$/,
      );
      if (provider === null) fail(`cannot parse provider row: ${line}`);
      if (!TOOLKIT_SLUG_PATTERN.test(provider[1])) {
        fail(`invalid toolkit slug ${provider[1]} in ${current.slug}`);
      }
      current.providers.push({
        slug: provider[1],
        displayName: provider[2],
        authClass: provider[3],
        source: provider[4],
        tier: provider[5],
        notes: provider[6],
      });
    }
  }

  const providers = new Map();
  for (const capability of capabilities) {
    if (capability.contractFocus.length === 0) {
      fail(`missing taxonomy focus for ${capability.slug}`);
    }
    if (capability.tools.length === 0) {
      fail(`capability ${capability.slug} has no canonical tools`);
    }
    for (const row of capability.providers) {
      const existing = providers.get(row.slug);
      if (existing === undefined) {
        providers.set(row.slug, {
          toolkit: {
            slug: row.slug,
            displayName: row.displayName,
            source: row.source,
            tier: row.tier,
          },
          authClass: row.authClass,
          memberships: [{ capability: capability.slug, notes: row.notes }],
        });
        continue;
      }

      const identity = [
        row.displayName,
        row.authClass,
        row.source,
        row.tier,
      ].join("|");
      const existingIdentity = [
        existing.toolkit.displayName,
        existing.authClass,
        existing.toolkit.source,
        existing.toolkit.tier,
      ].join("|");
      if (identity !== existingIdentity) {
        fail(`provider metadata disagrees across matrices for ${row.slug}`);
      }
      if (
        existing.memberships.some(
          ({ capability: existingCapability }) =>
            existingCapability === capability.slug,
        )
      ) {
        fail(`duplicate provider ${row.slug} in ${capability.slug}`);
      }
      existing.memberships.push({
        capability: capability.slug,
        notes: row.notes,
      });
    }
  }

  const contractCount = capabilities.reduce(
    (total, capability) => total + capability.tools.length,
    0,
  );
  const tiers = { P0: 0, P1: 0, P2: 0 };
  for (const provider of providers.values()) tiers[provider.toolkit.tier] += 1;

  if (capabilities.length !== EXPECTED.capabilities) {
    fail(
      `expected ${EXPECTED.capabilities} capabilities, found ${capabilities.length}`,
    );
  }
  if (contractCount !== EXPECTED.contracts) {
    fail(`expected ${EXPECTED.contracts} contracts, found ${contractCount}`);
  }
  if (providers.size !== EXPECTED.providers) {
    fail(`expected ${EXPECTED.providers} providers, found ${providers.size}`);
  }
  if (JSON.stringify(tiers) !== JSON.stringify(EXPECTED.tiers)) {
    fail(
      `expected tier counts ${JSON.stringify(EXPECTED.tiers)}, found ${JSON.stringify(tiers)}`,
    );
  }

  return {
    capabilities: capabilities.map(
      ({ slug, displayName, contractFocus, tools }) => ({
        slug,
        displayName,
        contractFocus,
        tools,
      }),
    ),
    providers: [...providers.values()],
  };
}

function render(data) {
  const json = JSON.stringify(data, null, 2);
  return `// Generated by packages/catalog/scripts/generate-baseline.mjs from docs/PROVIDERS.md.\n// Do not edit by hand. Run \`pnpm --filter @eyeball/catalog generate\` instead.\n\nimport { deepFreeze } from "./immutable.js";\nimport type {\n  CapabilityCatalogEntry,\n  ProviderCatalogEntry,\n} from "./types.js";\n\nconst baseline = ${json} as const;\n\nexport const CAPABILITY_CATALOG = deepFreeze(\n  baseline.capabilities satisfies readonly CapabilityCatalogEntry[],\n);\n\nexport const PROVIDER_CATALOG = deepFreeze(\n  baseline.providers satisfies readonly ProviderCatalogEntry[],\n);\n`;
}

function format(source) {
  const result = spawnSync(
    "pnpm",
    ["exec", "biome", "format", "--stdin-file-path", fileURLToPath(TARGET)],
    { cwd: ROOT, encoding: "utf8", input: source },
  );
  if (result.status !== 0) {
    fail(`Biome could not format generated data: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

const markdown = await readFile(SOURCE, "utf8");
const output = format(render(parseCatalog(markdown)));
if (process.argv.includes("--check")) {
  const current = await readFile(TARGET, "utf8").catch(() => undefined);
  if (current !== output) {
    fail(`generated data is stale; run from ${ROOT}`);
  }
} else {
  await writeFile(TARGET, output);
}
