# Contributing to eyeball

eyeball is open source because integrations are a problem solved faster by many
hands than by one company. The most valuable contribution is usually a new
**toolkit** (a provider integration) or hardening an existing adapter against a
real provider — but bug reports, docs fixes, and design feedback are just as
welcome. Every adapter that lands is another tool every agent can reach.

By contributing you agree your work is licensed under the repository's
[MIT license](./LICENSE.md).

## Ground rules

- Be kind and assume good faith. We follow the
  [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
- Open an issue before a large change so we can agree on shape first.
- Keep PRs focused: one toolkit, one fix, or one feature per PR.

## Project shape

- **Node.js 24+ and pnpm 11.** `pnpm install`, then `pnpm build`.
- `packages/core` — canonical contracts, credentials, execution seams.
- `packages/catalog` — provider **manifests** (`src/manifests/*`), **capability**
  schemas (`src/capabilities/*`), and tool discovery.
- `packages/toolkits` — the provider **adapters**.
- `packages/sdk`, `apps/executor`, `apps/mcp-gateway`, `apps/dashboard`,
  `apps/docs` — the client, execution API, MCP surface, admin panel, docs site.
- `mocks/` — Mockhouse: deterministic provider doubles used by the test suite.

Read `VISION.md` for the why, `SPEC.md` for the architecture, and
`docs/rfcs/001-canonical-tools.md` for the tool contract.

## Every change must pass the gates

Run these before opening a PR. They are the same gates CI enforces:

~~~sh
pnpm build
pnpm test          # includes the contract matrix
pnpm typecheck
pnpm lint
~~~

If you changed catalog or docs content, also run the documentation validators:

~~~sh
pnpm docs:generate   # regenerates toolkit + SDK reference pages (never hand-edit them)
pnpm docs:check
~~~

Tests are in-process and require no live accounts or open ports.

## Adding a toolkit (the common contribution)

1. **Model the capability, not the vendor.** Tools use canonical
   `toolkit.operation` names (e.g. `gmail.send_email`) whose input/output
   schemas come from a shared capability family in
   `packages/catalog/src/capabilities`. Reuse an existing family where one fits;
   propose a new one in an issue if none does.
2. **Add the manifest** in `packages/catalog/src/manifests`: toolkit metadata,
   auth class (`oauth2` / `api_key` / `basic` / `none`), and the operations it
   supports. Operations a provider genuinely cannot support are declared
   `not_supported` — that is expected and keeps the contract honest.
3. **Write the adapter** in `packages/toolkits`. Adapters receive a resolved
   credential and canonical input, call the provider, and return canonical
   output. Normalize errors through the shared taxonomy — never throw a raw
   `Error` across the boundary.
4. **Add a mock** so the toolkit is certified without a live account. The
   deterministic mocks live in a separate repository (`mocks/` when checked
   out) that may not be public yet — if you don't have access, ship the
   manifest and adapter with your declared operations, note it in the PR, and
   a maintainer will pair with you on the mock and contract rows.
5. **Regenerate docs** (`pnpm docs:generate`) and run the gates above.

[docs/ADDING-A-PROVIDER.md](./docs/ADDING-A-PROVIDER.md) walks the same five
steps with annotated code skeletons for each file.
`docs/CERTIFICATION.md` explains mock-vs-real certification. Live-provider
certification (running against a real account) is a great follow-up PR once the
mock path is green.

## Reporting bugs

Open an issue with what you expected, what happened, and the smallest
reproduction you can (a failing test is ideal). Never paste real credentials,
tokens, or customer data — redact them.

## Security

Do not open a public issue for a vulnerability. See
[docs/SECURITY.md](./docs/SECURITY.md) for how to report privately.

Thanks for adding eyes for agents. 👁️
