# Adding a provider adapter

This recipe follows the existing Notion and Twilio integrations. A provider is a manifest, a canonical adapter, a deterministic vendor-shaped mock, and contract coverage—not a provider-specific API exposed to agents.

> **Mocks repository access:** the deterministic provider mocks live in a
> separate repository checked out at `mocks/`. If it is not public (or you do
> not have access), complete the manifest and adapter steps, skip the mock
> steps, and say so in your PR — a maintainer will add the mock and contract
> rows with you. The gates that need built mocks (`pnpm test:contract`,
> `pnpm dev:stack`, parts of the executor suite) only run with that checkout
> present.

## 1. Choose the smallest canonical surface

Start in `packages/catalog/src/capabilities/` and use an existing capability contract whenever the provider fits one. Declare only the canonical operations the adapter really implements; undeclared operations are expected to return `not_supported` without contacting the provider.

If the provider needs a new canonical operation or capability, first add the capability slug in `packages/core/src/types/tool.ts`, define the versioned contract in `packages/catalog/src/capabilities/`, and register its exports/contracts in the catalog. A new contract also needs deterministic contract fixtures and a `describeCapability(...)` call in `apps/executor/test/contract/contract.test.ts`. Do this before adding a provider-specific implementation.

## 2. Add the provider manifest

Create `packages/catalog/src/manifests/<slug>.ts`. The manifest is the catalog truth for auth, provider endpoint, supported canonical tools, and optional triggers.

```ts
// packages/catalog/src/manifests/acme.ts
import type { ProviderManifest } from "@eyeball/core";
import { deepFreeze } from "../immutable.js";

export const acmeManifest = deepFreeze({
  schemaVersion: "1.0",
  catalogVersion: "1.1", // Match the active catalog version.
  toolkit: {
    slug: "acme",
    displayName: "Acme",
    source: "native", // Use the real implementation lineage.
    tier: "P0",
  },
  auth: {
    class: "api_key", // One of oauth2 | api_key | basic | none.
    fields: ["apiKey"],
  },
  endpoint: {
    baseUrl: "https://api.acme.example",
    // Lets the same adapter point at the deterministic Mockhouse provider.
    baseUrlOverrideEnv: "EYEBALL_ACME_BASE_URL",
  },
  implements: [
    {
      capability: "spreadsheets_databases", // An existing canonical capability.
      canonicalTool: "list_rows",
      canonicalVersion: "1.0.0", // Copy the contract's exact version.
      operationId: "records.list", // Provider operation for traceability.
    },
  ],
  // Add triggers only when this adapter actually implements them.
} as const satisfies ProviderManifest);
```

Use the real auth class and fields, a trusted provider base URL, and an override env var for an HTTP provider. Do not list a tool merely because the vendor supports it; the adapter and contract matrix must support every declared row.

## 3. Register the manifest and catalog count

Make the manifest discoverable in all catalog entry points:

1. Export it from `packages/catalog/src/index.ts`.
2. Import it and add it to the `manifests` list in `packages/catalog/src/default.ts`.
3. Update the intentional manifest-count assertions in `scripts/generate-docs.ts` and `scripts/check-docs.ts` (currently 37) to the new count.

Those count checks protect the generated documentation inventory. Do not edit files under `docs-site/toolkits/generated/` or `docs-site/docs.json` by hand.

## 4. Implement the canonical adapter

Add `packages/toolkits/src/<area>/<slug>.ts`. Follow the `AdapterContext` pattern: accept canonical input, make a vendor request through `createProviderHttpClient(context)`, validate the vendor payload, and return the contract's canonical output.

```ts
// packages/toolkits/src/productivity/acme.ts
import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import { asJson, inputString, isRecord, providerError, unsupported } from "./common.js";

export class AcmeAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "acme";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "acme.list_rows":
        return this.listRows(context);
      default:
        return unsupported(context); // Canonical, zero-provider-traffic fallback.
    }
  }

  private async listRows(context: AdapterContext): Promise<JsonValue> {
    const databaseId = inputString(context, "databaseId");
    const request = createProviderHttpClient(context);
    const response = await request(
      `v1/databases/${encodeURIComponent(databaseId)}/records`,
    );
    const payload: unknown = await response.json();

    if (!isRecord(payload)) {
      throw providerError(context, "Acme returned an invalid records response");
    }

    return asJson({
      // Implement and validate this mapping against the canonical contract.
      rows: mapAcmeRecordsToCanonicalRows(payload),
    });
  }
}

export const acmeAdapter = new AcmeAdapter();
```

The skeleton's helper names are illustrative; use the area’s existing helpers and exact contract field names. Do not call `context.fetchImpl` directly, accept an arbitrary base URL from tool input, or pass provider credentials through canonical input. `createProviderHttpClient` provides resolved authentication, same-origin protection, cancellation, normalized provider failures, and credential redaction.

## 5. Register the adapter

For an existing toolkit area, export the new adapter and place it in that area’s adapter array. For example, `packages/toolkits/src/productivity/index.ts` follows this shape:

```ts
import type { ToolkitAdapter } from "@eyeball/core";
import { acmeAdapter } from "./acme.js";

export * from "./acme.js";

export const productivityToolkitAdapters = Object.freeze([
  // existing adapters,
  acmeAdapter,
] as const satisfies readonly ToolkitAdapter[]);
```

`packages/toolkits/src/index.ts` already combines the area arrays into `defaultToolkitAdapters`; update it only when introducing a new area. Ordinary adapters need no manual change in `apps/executor/src/adapters/registry.ts`, because the executor receives the default array. If an adapter has a special runtime dependency like Twilio’s number binding, wire the constructed instance in both the executor runtime and `scripts/dev-stack.ts` so local development and production agree.

## 6. Add a deterministic Mockhouse provider

Work in the nested `mocks/` repository. Add a vendor-shaped mock at `mocks/packages/mocks-<area>/src/<slug>.ts`, export its factory and fixtures through that area’s `src/index.ts`, and add it to the area's `providers` list. A new area also needs Mockhouse composition wiring.

The mock must expose the vendor-like routes that the real adapter calls, including its normal error envelope. Seed it with obvious fake fixture data; use the injected deterministic store, clock, IDs, and pagination. Implement supported `fixture:*` auth, plus vendor-shaped 401, 403, and 429 cases. Never alter the adapter to know it is using a mock, use wall-clock values, randomness, or real network egress.

Build the nested repository before running root contracts, then add its compiled factory and fixture entry to the `MOCKS` mapping in `apps/executor/test/contract/targets.ts`:

```ts
// apps/executor/test/contract/targets.ts
const MOCKS = {
  // existing providers,
  acme: { create: createAcmeMock, seed: acmeFixtures.default },
} as const;
```

## 7. Let the contract matrix prove the declared surface

For an existing capability, do not hand-write a provider-by-tool test matrix. The runner derives declared operations from the default catalog: every manifest row receives canonical success/error coverage, and omitted operations are checked for `not_supported` with zero provider traffic.

For a new capability or operation, add the corresponding fixture registry in `apps/executor/test/contract/fixtures/<area>.ts` and call `describeCapability(...)` from `contract.test.ts`. The default target is deterministic mocks; real-provider certification is a separate credential-gated run of the same canonical flow, not something the mock result can claim.

## 8. Generate documentation

After the catalog is complete, run:

```bash
pnpm docs:generate
```

The generator owns toolkit reference pages and navigation. Review the generated diff, but never hand-edit generated toolkit pages or navigation files. Add only authored explanatory documentation outside generated output when it is genuinely needed.

## 9. Run the gates

Run the mock build first because the main repository imports compiled mock packages for its contract target.

```bash
pnpm --dir mocks build
pnpm --dir mocks test
pnpm --dir mocks typecheck
pnpm --dir mocks lint

pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm test:contract

pnpm docs:generate
pnpm docs:check
pnpm docs:snippets
pnpm docs:typecheck
```

`pnpm test:contract` defaults to the built deterministic mock target. Use `EYEBALL_CONTRACT_TARGET=real` only when the provider’s credentials and real prerequisites are intentionally available; missing credentials should surface as explicit skips.

## 10. Prepare the contribution

Include the manifest, adapter, nested mock source and rebuilt mock artifacts, registration changes, generated documentation output, and any new capability fixtures/contracts. In the PR, name the canonical tools that are intentionally unsupported, explain mock fidelity and error behavior, and keep real-provider certification claims separate from successful mock coverage.
