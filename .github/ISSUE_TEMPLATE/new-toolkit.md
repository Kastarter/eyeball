---
name: New toolkit / provider
about: Propose or claim a new provider integration
title: "toolkit: <provider name>"
labels: ["toolkit", "good first issue"]
---

**Provider:** <name + link to its API docs>

**Capability family:** <email / messaging / crm / ecommerce / calendar / pm /
social-data / payments / erp / voice — or "new family, because …">

**Auth class:** <oauth2 / api_key / basic / none>

**Operations to support:** <e.g. list, get, create, send — the canonical
operations you plan to implement; note any the provider genuinely cannot support>

**Notes / open questions:** <rate limits, pagination style, anything unusual>

---
See [CONTRIBUTING.md](../../CONTRIBUTING.md) → "Adding a toolkit". Manifest goes
in `packages/catalog/src/manifests`, adapter in `packages/toolkits`, mock in the
`mocks/` repo. I'm happy to pair on the first one — say so here.
