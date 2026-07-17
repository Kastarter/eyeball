# `@eyeball/bridge` (experimental spike)

This package is a compatibility proving ground for executing a curated subset of
Activepieces community pieces through eyeball's `ToolkitAdapter` contract. It is
private, unsupported, and intentionally not production-ready. Exact npm-to-source
license provenance must be established before any redistribution.

The spike covers five pinned pieces: Gmail, Airtable, Slack, Discord, and
Typeform. It provides:

- deterministic action/trigger/auth/property introspection;
- a Draft 2020-12 property-to-JSON-Schema prototype;
- connection-time hydration for real `DYNAMIC` properties;
- a minimal `ResolvedCredential` and `AdapterContext` execution shim; and
- in-process Mockhouse tests for Gmail, Slack, and Airtable.

The selected piece artifacts are self-contained bundles and do not declare the
framework or shared package as peers. This spike nevertheless pins
`@activepieces/pieces-framework` and its matching `@activepieces/shared` version
to make the compatibility surface and dependency weight reproducible.

Run the report with `pnpm --filter @eyeball/bridge introspect`. The engineering
verdict, transport limitations, license notes, and production recommendation are
in `docs/rfcs/003-bridge-spike-findings.md`.

Do not add this package to the catalog or claim broad Activepieces compatibility.
Each production piece needs an explicit semantic mapping, credential policy,
network boundary, dynamic-property strategy, and contract test.
