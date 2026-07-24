# Release decision packet

Decision date: 2026-07-24.

This packet covers the founder-independent launch work in three private,
separately versioned repositories:

- OSS main: `https://github.com/Kastarter/eyeball.git`;
- read-only mocks: `https://github.com/Kastarter/eyeball-mocks.git`; and
- private Cloud: `https://github.com/Kastarter/eyeball-cloud.git`.

All three repositories were synchronized with their respective `origin/main`
before this packet was written. No npm organization was created, no license
language was invented, no deployment was made, no live provider was called, and
no public-availability claim is authorized by this packet.

## Executive decision

| Track | Security verdict | Release recommendation |
| --- | --- | --- |
| A — OSS npm packages | **Conditional go.** No code-level security blocker was found in the four public tarballs. | **Recommendation — release-now-viable after prerequisites, as 0.3.0 from current `main`; do not publish the current post-cut code as 0.2.0.** |
| B — hosted public multi-tenant Cloud | **Wait.** Concrete cross-boundary risks and unevidenced production operations remain. | **Recommendation — wait. Do not launch the current source as a general public multi-tenant hosted service.** |

The complete security rationale is the
[`RELEASE-SECURITY-VERDICT`](./SECURITY.md#release-security-verdict). This
packet applies those verdicts to the current repository, release-workflow, and
artifact state.

## Verification matrix

Every heavy command ran alone with a 2 GiB Node heap cap, one Vitest worker, and
serial Turbo execution. No test server or loopback port was started.

| Repository / scope | Gate | Result |
| --- | --- | --- |
| Main / release | `pnpm test:release` | **Green:** 6/6 release-manifest tests. |
| Main / release | `TURBO_FORCE=true pnpm release:build` | **Green:** 4/4 public packages rebuilt uncached and serially. |
| Main / release | `pnpm release:dry-run` | **Green:** 4/4 non-publishing tarball previews. |
| Main / release | provenance dry run | **Green:** pnpm accepted `--dry-run --provenance` for all four packages. Actual attestation still requires the protected GitHub Actions OIDC publish. |
| Main / release | `pnpm changeset:status` | **Command green; sequencing action required:** six pending Changesets move the fixed public group from 0.2.0 to 0.3.0. The publish job will reject this state until the version PR is merged. |
| Main / root tests | `TURBO_FORCE=true pnpm test` | **Green:** 1,475 passed; 4 conditional tests skipped; 14/14 Turbo tasks executed uncached. |
| Main / contract | `pnpm test:contract` | **Green:** 37 providers, 493 rows, 227 pass, 266 explicit `not_supported`, 0 skipped rows, 0 failed rows. |
| Main / types | `TURBO_FORCE=true pnpm typecheck` | **Green:** 10/10 uncached serial tasks. |
| Main / lint/security | `TURBO_FORCE=true pnpm lint` | **Green:** tracked-file secret scan and 10/10 uncached serial lint tasks. One non-failing Turborepo cache-model warning remains for `EYEBALL_DATABASE_URL`. |
| Main / docs | four `docs:*` validators | **Green:** generation/structure, snippets, docs TypeScript, and generated SDK tests. |
| Main / Python worker | `uv sync --extra dev`; `uv run --no-sync pytest` | **Green:** 18/18 tests. |
| Private Cloud | build, test, typecheck, lint | **Green:** build, 79/79 tests, typecheck, and 52-file Biome gate. |
| Read-only mocks | uncached build, test, typecheck, lint | **Green:** 8 builds, 164/164 tests, 8 typechecks, and 8 lints. Repository remained clean. |

The account-free implementation gates are green. This does not convert
uncertified live-provider rows into passes and does not evidence a production
deployment.

## Track A — OSS npm packages

### Security decision

The reviewed public boundary is exactly:

- `@eyeball/core`;
- `@eyeball/catalog`;
- `@eyeball/toolkits`; and
- `@eyeball/sdk`.

The security verdict is **conditional go**. SEC-002 and SEC-017 are hosted
service boundaries. SEC-003 and SEC-009 remain in the excluded private
Activepieces bridge. SEC-010 concerns the separately deployed Python worker.
No signing key, live capability, fixture credential, worker database, private
Cloud source, or deployment secret is present in the npm artifacts.

### What is proven

The current `0.2.0` dry-run artifacts have this exact manifest:

| Package | Compressed | Unpacked | Files | Packed internal dependencies |
| --- | ---: | ---: | ---: | --- |
| `@eyeball/core@0.2.0` | 64,286 B | 310,517 B | 83 | none |
| `@eyeball/catalog@0.2.0` | 181,849 B | 1,309,509 B | 223 | `@eyeball/core: 0.2.0` |
| `@eyeball/toolkits@0.2.0` | 161,623 B | 952,937 B | 187 | `@eyeball/core: 0.2.0` |
| `@eyeball/sdk@0.2.0` | 29,477 B | 130,795 B | 23 | `@eyeball/catalog: 0.2.0`; `@eyeball/core: 0.2.0` |

Every archive is below the 2 MiB ceiling. Exact file-list inspection found only
`dist/**`, `README.md`, `LICENSE.md`, and `package.json`. There are no raw
source trees, tests, TypeScript/Vitest configs, environment files, credentials,
private apps, Cloud files, mocks, or worker files. Published source maps reveal
relative source paths by design but contain no embedded `sourcesContent`.

Package entry points and type declarations resolve to built `dist` files.
`workspace:*` dependencies rewrite to the concrete package version. The package
license field resolves to the included `LICENSE.md`. `publishConfig.access` is
`public`, and the workflow accepts the npm provenance flag.

The 493-row mock contract matrix proves deterministic schema/adapter behavior
against Mockhouse. It is not live-provider certification; every provider in
[`CERTIFICATION.md`](./CERTIFICATION.md) remains `not yet certified`, except
planned unshipped entries.

### Version sequencing blocker

The four manifests still say `0.2.0`, but the current source is no longer the
original 0.2.0 cut. Six pending Changesets produce this fixed-group result:

- `@eyeball/core`: `0.2.0` → `0.3.0`;
- `@eyeball/catalog`: `0.2.0` → `0.3.0`;
- `@eyeball/toolkits`: `0.2.0` → `0.3.0`; and
- `@eyeball/sdk`: `0.2.0` → `0.3.0`.

The protected workflow explicitly rejects a manual publish while a pending
release has a type other than `none`. The founder-independent checks therefore
support the current code as a `0.3.0` release candidate after the generated
version PR is reviewed and merged. A 0.2.0 release would need a separately
reviewed branch from the original cut commit `2fa6fe0`; publishing current
post-cut code under 0.2.0 would contradict its checked-in release intent.

After the version PR, rerun the artifact audit because versions, changelogs, and
packed dependency ranges will change.

### Manifest URL reconciliation

The tarball `repository.url` and `homepage` fields are syntactically complete
but do not point to the verified pushed repository:

- checked-in metadata: `github.com/eyeball-ai/eyeball`;
- verified private remote: `github.com/Kastarter/eyeball`.

Founder question: **Is Kastarter the canonical launch organization, or only the
staging/private push before transfer to eyeball-ai?**

- If Kastarter is canonical, update all four manifests, the
  release-manifest test, runbook references, and GitHub CLI commands to
  `Kastarter/eyeball`.
- If eyeball-ai is canonical, transfer or establish the approved repository
  there, then verify and align `origin` before publishing.

Do not publish package metadata that points to an unconfirmed canonical
repository.

### Exact remaining founder-owned gates

1. **License:** counsel supplies the final approved license text and
   redistribution terms for the root and four package copies. The current
   one-line FSL-1.1 placeholder is not publishable.
2. **npm ownership and token:** create/control the `@eyeball` npm organization,
   grant all four package permissions, protect the GitHub `npm` environment,
   and store an authorized automation `NPM_TOKEN`.
3. **Security channel:** provision and test the disclosure mailbox or replace
   the placeholder, publish the monitored contact, and provide an encrypted
   intake path.
4. **Release decisions:** select the canonical GitHub organization and approve
   the current-main 0.3.0 version path or a separately reviewed 0.2.0 branch.
5. **Protected publication approval:** merge the Changesets version PR, confirm
   no pending releases, approve `confirm=publish`, then verify all four registry
   versions and provenance attestations.

The external account prerequisites specifically required for the npm command
to succeed are the `@eyeball` organization/package rights and `NPM_TOKEN`. The
license and monitored disclosure channel are policy/security prerequisites even
though npm itself cannot enforce them.

### Residual risks accepted with the OSS release

- Source maps disclose relative package source layout, without source content.
- Public packages include voice contracts and the remote session driver, not a
  worker deployment, signing key, or live grant.
- The latest online advisory query was unavailable during the security review;
  evidence is the unchanged audited baseline, secret scan, exact lockfiles, and
  tarball inspection.
- The private Activepieces spike and its advisories do not ship.
- Live provider behavior is not certified. Public claims must describe
  Mockhouse/account-free coverage accurately.
- These are pre-1.0 APIs. The pending minor Changesets are a concrete example of
  why fixed-group versioning remains appropriate.

### Track A recommendation

**Recommendation — release-now-viable after prerequisites, as 0.3.0 from current
`main`; do not publish the current post-cut code as 0.2.0.**

No additional code-security fix is required inside the four reviewed package
tarballs. The blockers are release sequencing, final legal/security operations,
canonical metadata, and npm authority.

## Track B — hosted Cloud multi-tenant launch

### Security decision

The security verdict is **wait**. The current code materially improves billing
atomicity, post-grace enforcement, durable queues/stores, cancellation,
readiness, remote voice recovery, and capability scope. It is still not safe to
claim general Internet-scale multi-tenant availability.

### Blocking register

| Finding | Public multi-tenant exposure | Required closure | Register estimate |
| --- | --- | --- | ---: |
| SEC-002 | DNS-rebinding/TOCTOU can route webhook delivery to private targets after validation. | Resolver-aware classification and address pinning on every connection plus network egress deny policy. | 3–5 days |
| SEC-017 | A learned same-project staged-file ID can cross a pinned-user boundary during its TTL. | Persist owner identity and enforce it on upload, metadata, and adapter byte resolution. | 1–2 days |
| SEC-025 | A stolen short-lived voice grant can be replayed from another worker until expiry/revocation. | Worker/deployment audience binding plus mutual identity or proof-of-possession signing. | 2–4 days |
| CLOUD-003 | Shared internal bearer requests have no freshness, body integrity, or replay defense. | HMAC method/path/body/timestamp and nonce deduplication. | 2–4 days |
| CLOUD-004 | Tenant isolation depends on application queries without Postgres RLS defense in depth. | Add/test RLS or a formally checked tenant-query abstraction. | 3–5 days |
| CLOUD-005 | KEK primitives exist without production KMS, dual control, backup-aware rotation, or an audited operator job. | Implement the operating tooling and exercise it. | 3–5 days plus infrastructure |
| CLOUD-006 | Cloud audit is not complete, immutable, centrally retained, alerted, and routinely reviewed. | Complete coverage and export to restricted immutable storage with alert/review evidence. | 3–5 days plus SIEM work |

SEC-025 and CLOUD-003/004/006 are described as accepted risks for the tightly
isolated preview boundary in the security verdict. This packet treats them as
blocking for a **general public multi-tenant** claim. SEC-008 also blocks Slack
push ingest unless that feature is disabled; native signature/freshness
verification is estimated at 2–4 days.

### Operational gates

Deployment manifests exist for the private control plane, dashboard/landing,
and voice worker, but they are source artifacts rather than evidence of a live
environment. Hosted launch still requires:

- a linked production deployment and domains;
- production Postgres with migration, connection, and restore evidence;
- KMS-backed key custody, dual control, backup-aware rotation, and tested
  recovery;
- immutable audit export, queue/observer/webhook alerting, incident routing, and
  a monitored security channel;
- live Stripe catalog/bootstrap, Checkout, Portal, webhook, metering,
  delinquency, and recovery drills;
- live OAuth application registration, callback/refresh/revocation drills, and
  provider certification;
- webhook DNS/egress controls and Slack provider signatures or explicit feature
  disablement;
- staged-file ownership migration and cross-user adversarial tests;
- worker-bound voice capabilities, isolated durable volume, live PSTN/WebRTC
  certification, restart/revocation evidence, and cleanup;
- multi-replica load/chaos evidence for leases, queues, observer takeover,
  source reconstruction, and billing admission; and
- a production backup/restore and incident-response exercise with retained
  evidence.

### Shortest credible path

1. Close SEC-002 and SEC-017 first; together they are 4–7 sequential
   engineering days and remove the two explicit cross-boundary launch gates.
2. In parallel where ownership allows, close SEC-025 and CLOUD-003/004/005/006.
   The full listed register is 17–30 sequential engineering days, plus KMS,
   infrastructure, and SIEM lead time.
3. Keep Slack push disabled or add 2–4 days for SEC-008.
4. Stand up the production environment only after the controls have regression
   coverage; then complete KMS/backup/monitoring and live Stripe/OAuth/provider
   drills.
5. Rerun the complete main, Cloud, Mockhouse, worker, contract, security, and
   documentation gates; update the security verdict only from retained
   production evidence.

Calendar time can be shorter if the security, data, Cloud, and operations work
streams run in parallel, but the register estimates are engineering estimates,
not a deployment-date promise.

### Track B founder-owned gates

1. Approve and resource the blocking-register work or approve an explicitly
   feature-gated private preview boundary; do not relabel preview isolation as
   general availability.
2. Supply the Vercel/Fly projects, production Postgres, KMS, backup storage,
   domains, OAuth applications, Stripe account, voice-provider accounts, and
   secret-manager ownership.
3. Establish dual-control key operations, immutable audit/SIEM ownership,
   monitored security intake, on-call routing, restore cadence, and incident
   authority.
4. Approve live-provider certification tenants, destructive cleanup procedures,
   evidence retention, and the final hosted-launch security review.

### Track B recommendation

**Recommendation — wait. Do not launch the current source as a general public
multi-tenant hosted service.**

A limited private preview is reasonable only if webhooks, Slack push ingest,
and multi-user staged files are disabled, the voice worker stays within its
documented isolated trust boundary, and the private-network, least-privilege,
upstream log-suppression, backup, and active-monitoring controls are actually
enforced.

## If you release now

If the founder completes Track A's version, canonical-repository, final-license,
monitored-security-contact, npm-organization/token, and protected-workflow gates,
exactly four npm packages ship: `@eyeball/core`, `@eyeball/catalog`,
`@eyeball/toolkits`, and `@eyeball/sdk`, recommended as version `0.3.0` from
current `main`. What does **not** ship is the executor service, dashboard, docs
app, landing app, MCP gateway service, private Activepieces bridge, Mockhouse,
private Cloud control plane, Python voice worker, any deployment, any hosted
service, any live-provider certification, or any claim that Cloud is ready for
general public multi-tenant traffic.
