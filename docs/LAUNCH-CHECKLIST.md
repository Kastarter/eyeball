# Eyeball launch checklist

Status date: 2026-07-24.

This checklist separates four different states that must not be conflated:

1. source and account-free verification;
2. an npm package release;
3. real-provider certification; and
4. a public multi-tenant hosted launch.

The repositories are privately pushed, but no npm package or hosted service is
claimed as public.

For local Node and pnpm commands, preserve the release-review limits:

~~~sh
export PATH="/opt/homebrew/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=2048"
export VITEST_MAX_THREADS=1
~~~

Run one command at a time. Use `--concurrency=1` for direct Turbo invocations,
inspect `vm_stat` before heavy steps, never bind test ports, and do not run a
Next build unless a changed application requires it.

## Complete

### Repository reality

- [x] Main is configured at
  `https://github.com/Kastarter/eyeball.git`; local `main` and `origin/main`
  were synchronized before this decision-packet commit.
- [x] The read-only Mockhouse repository is configured at
  `https://github.com/Kastarter/eyeball-mocks.git`; local `main` and
  `origin/main` were synchronized and the verification run left it clean.
- [x] Private Cloud is configured at
  `https://github.com/Kastarter/eyeball-cloud.git`; local `main` and
  `origin/main` were synchronized. Its existing untracked `.DS_Store` was not
  modified or committed.
- [x] The stale claim that neither writable repository had a remote is retired.
  These are private GitHub pushes, not evidence of npm publication or a live
  hosted deployment.

### Source and account-free evidence

- [x] The release-security verdicts are recorded in
  [`SECURITY.md`](./SECURITY.md#release-security-verdict): OSS npm publication
  is **conditional go**; general public multi-tenant hosted launch is **wait**.
- [x] The catalog contains 37 executable manifests. The fresh account-free
  contract report contains 493 rows: 227 pass, 266 explicit `not_supported`,
  zero skipped rows, and zero failed rows.
- [x] Root direct tests plus all uncached serial workspace test tasks passed:
  1,475 tests passed and four intentionally conditional tests were skipped.
- [x] Root typecheck passed all ten workspace tasks uncached and serially.
- [x] Root lint passed the tracked-file secret scan and all ten workspace tasks
  uncached and serially. Biome retains one non-failing warning that
  `EYEBALL_DATABASE_URL` is not declared to Turborepo's cache model.
- [x] All four documentation validators pass:
  `pnpm docs:check`, `pnpm docs:snippets`, `pnpm docs:typecheck`, and
  `pnpm docs:sdk:test`.
- [x] The Python voice-worker environment synchronized with `uv sync --extra
  dev`; `uv run --no-sync pytest` collected and passed all 18 tests.
- [x] Private Cloud passes build, 79 tests, typecheck, and lint under the serial
  2 GiB policy.
- [x] The read-only Mockhouse repository passes eight builds, 164 tests, eight
  typechecks, and eight lints uncached and serially; it remained clean.
- [x] The four public packages build uncached and serially. Release-manifest
  tests pass all six cases.
- [x] The npm dry run and an additional provenance dry run both succeed without
  publishing. Every tarball contains only `dist/**`, `README.md`, `LICENSE.md`,
  and `package.json`; raw source, tests, configs, environment files, Cloud
  source, worker source, and credentials are absent. Source maps expose relative
  source paths but do not embed `sourcesContent`.
- [x] Packed `workspace:*` dependencies rewrite to exact `0.2.0` versions in the
  current artifacts.

| Tarball | Compressed | Unpacked | Files |
| --- | ---: | ---: | ---: |
| `@eyeball/core@0.2.0` | 64,286 B | 310,517 B | 83 |
| `@eyeball/catalog@0.2.0` | 181,849 B | 1,309,509 B | 223 |
| `@eyeball/toolkits@0.2.0` | 161,623 B | 952,937 B | 187 |
| `@eyeball/sdk@0.2.0` | 29,477 B | 130,795 B | 23 |

All four are below the 2 MiB compressed ceiling. Recreate and inspect them
after any version, license, metadata, or build change:

~~~sh
pnpm test:release
TURBO_FORCE=true pnpm release:build
pnpm release:dry-run
pnpm --filter @eyeball/core --filter @eyeball/catalog --filter @eyeball/toolkits --filter @eyeball/sdk -r publish --dry-run --provenance --no-git-checks --json
~~~

## Decisions and external gates for OSS npm publication

### 1. Choose the release line and merge its version PR

`pnpm changeset:status` now succeeds against the pushed Git baseline and reports
six pending Changesets. Because the public packages are a fixed group, all four
move from `0.2.0` to `0.3.0`, including `@eyeball/catalog`, which has no direct
pending Changeset. The protected publish job deliberately refuses to publish
while any of those releases remain pending.

The recommended path is to publish the current reviewed source as `0.3.0`:

~~~sh
pnpm changeset:status
git push origin main
gh run list --repo <canonical-org>/eyeball --workflow Release
gh pr list --repo <canonical-org>/eyeball --search 'chore(release): version public packages'
~~~

Review and merge the Changesets version PR. Then verify the clean publication
state locally:

~~~sh
git pull --ff-only
pnpm install --frozen-lockfile
pnpm changeset:status
pnpm release:version
pnpm test:release
TURBO_FORCE=true pnpm release:build
pnpm release:dry-run
~~~

`pnpm changeset:status` must then report no pending non-`none` release and
`pnpm release:version` must confirm fixed-version agreement.

If the founder instead insists on `0.2.0`, create a reviewed release branch from
the original cut commit `2fa6fe0` and rerun the complete security and release
review on that branch. Do not publish the current post-cut source under
`0.2.0`; its pending public changes are already classified as a minor release.

### 2. Choose the canonical public GitHub organization

The verified private push is `Kastarter/eyeball`, while all four package
`repository.url` and `homepage` fields plus the release-manifest test still name
`eyeball-ai/eyeball`. This is unresolved by design.

Path A — **Kastarter is the launch organization**:

1. Change `repository.url` and `homepage` in the four public package manifests
   to `Kastarter/eyeball`.
2. Change the expected values in `scripts/release-manifests.test.ts`.
3. Replace release-runbook and GitHub CLI references to
   `eyeball-ai/eyeball`.

~~~sh
rg -n 'eyeball-ai/eyeball|Kastarter/eyeball' packages scripts docs .github
pnpm test:release
pnpm release:dry-run
git diff --check
~~~

Path B — **eyeball-ai is the launch organization**:

1. Create or confirm the organization and transfer the reviewed repository, or
   establish the approved canonical repository there.
2. Only after ownership is confirmed, align the remote and push.

~~~sh
git remote -v
git remote set-url origin https://github.com/eyeball-ai/eyeball.git
git push -u origin main
git ls-remote --exit-code origin HEAD
~~~

Do not rewrite package metadata to Kastarter and do not transfer the repository
to eyeball-ai until the founder answers: **Is Kastarter the canonical launch
organization, or only the staging/private push?**

### 3. Finalize the public license

`LICENSE.md` and all four package license copies currently contain one line:
“FSL-1.1 — Functional Source License. Final license text pending legal review.”
The package `license` field correctly resolves to the included `LICENSE.md`, but
that file is not publication-ready. Counsel must supply the exact approved text
and redistribution terms.

~~~sh
pnpm test:release
pnpm release:build
pnpm release:dry-run
git add LICENSE.md packages/core/LICENSE.md packages/catalog/LICENSE.md packages/toolkits/LICENSE.md packages/sdk/LICENSE.md docs/RELEASING.md
git commit -m "legal: finalize public package license"
~~~

Do not publish while [`RELEASING.md`](./RELEASING.md) describes the license as
a legal-review placeholder.

### 4. Provision and test the security disclosure channel

`security@eyeball.dev` is explicitly a placeholder and must not be represented
as monitored. Before a public package release, provision and test that mailbox
or replace it everywhere, publish the contact, and define the encrypted intake
path.

~~~sh
rg -n 'security@eyeball.dev|placeholder|monitored' docs/SECURITY.md docs/INCIDENT-RESPONSE.md docs-site
pnpm docs:check
pnpm docs:snippets
pnpm docs:typecheck
pnpm docs:sdk:test
~~~

### 5. Provision npm ownership and protected publication

An `@eyeball` organization owner must grant publish access for all four
packages and create an automation token. Protect the `npm` GitHub environment
with required reviewers before storing the token.

~~~sh
npm whoami
npm access list packages @eyeball
gh secret set NPM_TOKEN --repo <canonical-org>/eyeball --env npm
gh workflow run Release --repo <canonical-org>/eyeball --ref main -f confirm=publish
npm view @eyeball/core@<release-version> version
npm view @eyeball/catalog@<release-version> version
npm view @eyeball/toolkits@<release-version> version
npm view @eyeball/sdk@<release-version> version
~~~

The workflow, not a local shell, performs the real publish with npm provenance.
Only update public claims after all four registry queries return the chosen
version and the provenance attestations are visible.

### 6. Run real-provider certification before making provider claims

Real-provider certification is not needed to prove that an npm tarball can be
published, but it is required before describing a provider path as certified.
Create dedicated vendor tenants and run small attributable batches:

~~~sh
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='<comma-separated-slugs>' pnpm test:contract
~~~

Required values are `EYEBALL_REAL_<TOOLKIT>_BASE_URL`, auth-specific
`EYEBALL_CRED_<TOOLKIT>_*` fields, and fixture variables named by skip reasons.
A skipped row is not a pass. Record only sanitized evidence in
[`CERTIFICATION.md`](./CERTIFICATION.md).

## Engineering and operational gates for hosted multi-tenant launch

The hosted security verdict is **wait**. SEC-002 and SEC-017 are now closed in
code (see [Engineering-deferred gates](#engineering-deferred-gates)); the
remaining register items below must be closed for a general public multi-tenant
launch, or the affected surface must be disabled in a narrowly controlled
preview:

| ID | Required closure | Estimate from security register |
| --- | --- | ---: |
| SEC-025 | Bind voice grants to a worker/deployment identity with mutual authentication or proof of possession. | 2–4 days |
| CLOUD-003 | Add method/path/body/timestamp signing and nonce deduplication for internal service requests. | 2–4 days |
| CLOUD-004 | Add and test Postgres RLS or a formally checked tenant-query boundary. | 3–5 days |
| CLOUD-005 | Integrate KMS, dual control, backup-aware KEK rotation, and an audited operator job. | 3–5 days plus infrastructure |
| CLOUD-006 | Export complete audit coverage to restricted immutable retention with alert/review evidence. | 3–5 days plus SIEM work |

These estimates sum to 13–23 sequential engineering days, plus infrastructure
and SIEM lead time. If Slack push ingest will be enabled, SEC-008 adds 2–4 days
for provider-native signature and freshness verification; otherwise keep that
surface disabled.

After each remediation, add adversarial regression coverage, update the
security register, and run:

~~~sh
vm_stat
pnpm test
pnpm typecheck
pnpm lint
pnpm docs:check
pnpm docs:snippets
pnpm docs:typecheck
pnpm docs:sdk:test
pnpm test:contract
pnpm --dir=/Users/khalidsh/eyeball/cloud run build
pnpm --dir=/Users/khalidsh/eyeball/cloud run test
pnpm --dir=/Users/khalidsh/eyeball/cloud run typecheck
pnpm --dir=/Users/khalidsh/eyeball/cloud run lint
uv run --project /Users/khalidsh/eyeball/apps/voice-worker --no-sync pytest
~~~

### Deploy and initialize only after the register closes

Deployment manifests exist, but there is no evidenced live environment, KMS
custody, restore drill, monitored security channel, or live OAuth/Stripe
certification. An owner must supply the private Vercel project, production
Postgres, KMS and backup model, domains, OAuth applications, and Stripe account.

~~~sh
vercel --cwd /Users/khalidsh/eyeball/cloud link
vercel --cwd /Users/khalidsh/eyeball/cloud env add DATABASE_URL production
vercel --cwd /Users/khalidsh/eyeball/cloud env add SESSION_SECRET production
vercel --cwd /Users/khalidsh/eyeball/cloud env add INTERNAL_API_SECRET production
vercel --cwd /Users/khalidsh/eyeball/cloud env add VAULT_MASTER_KEY production
vercel --cwd /Users/khalidsh/eyeball/cloud env add OAUTH_INTENT_SECRET production
vercel --cwd /Users/khalidsh/eyeball/cloud env add OAUTH_CALLBACK_URL production
vercel --cwd /Users/khalidsh/eyeball/cloud env add STRIPE_SECRET_KEY production
vercel --cwd /Users/khalidsh/eyeball/cloud env add STRIPE_WEBHOOK_SECRET production
pnpm --dir=/Users/khalidsh/eyeball/cloud run build
vercel --cwd /Users/khalidsh/eyeball/cloud deploy --prod
pnpm --dir=/Users/khalidsh/eyeball/cloud run billing:bootstrap
~~~

The bootstrap command must run in an authenticated operator environment with
the same production database and Stripe values. Configure Stripe webhook events
and the external job scheduler from `cloud/README.md`. Before claiming
availability, retain evidence for restore, KEK rotation, OAuth, key
export/verification, Checkout, Portal, webhook, delinquency, multi-replica
load/chaos, and alert-response drills.

### Certify live voice paths

Deploy the worker only after SEC-025 is closed or within the explicitly isolated
preview boundary. Use a dedicated single-Machine deployment and durable SQLite
volume; never treat the static worker key as multi-user authority.

~~~sh
fly volumes create voice_worker_data --region <region> --size 10 --app <app>
fly secrets set --app <app> EYEBALL_VOICE_WORKER_TOKEN='...' EYEBALL_EXECUTOR_URL='https://executor.example.com' EYEBALL_VOICE_PUBLIC_URL='https://<app>.fly.dev' ANTHROPIC_API_KEY='...' DEEPGRAM_API_KEY='...' ELEVENLABS_API_KEY='...' TWILIO_ACCOUNT_SID='...' TWILIO_AUTH_TOKEN='...' TWILIO_FROM_NUMBER='...' LIVEKIT_URL='...' LIVEKIT_API_KEY='...' LIVEKIT_API_SECRET='...'
fly deploy --config /Users/khalidsh/eyeball/apps/voice-worker/fly.toml --app <app> --region <region>
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='deepgram,elevenlabs,livekit,pipecat,twilio,voice-agents' pnpm test:contract
~~~

Retain sanitized evidence for outbound and supported inbound PSTN, WebRTC,
speech-to-text, model turns, text-to-speech, child execution identity, webhook
delivery, restart recovery, capability revocation, and cleanup. Account-free
worker tests prove the control-plane contract and mocked request assembly only.

## Engineering-deferred gates

These are neither account setup nor release ceremony; they require code or operations work and must remain visible in launch decisions:

- SEC-002 P1: Fixed. Webhook delivery now dials through a resolver-aware guarded transport that classifies and pins the resolved address on every connection, fails closed on private/empty/non-HTTPS resolutions, and is the default in the engine and runtime compositions (`webhooks/ssrf.ts`, `apps/executor/test/ssrf.test.ts`). A network-layer egress deny policy remains a recommended defense-in-depth control, not a code gate.
- SEC-017 P1: Fixed. Staged files now bind an optional owner user ID at upload to the effective identity (`pinnedUserId ?? X-Eyeball-User-Id`); single-file metadata (`GET /v1/files/:id`) and adapter byte resolution enforce ownership in the file-store contract, resolving an owned record only for its owner and failing closed for a mismatched or absent identity, while owner-less legacy/project-scoped uploads stay project-visible (`migrations/0010_staged_file_owner.sql`, `apps/executor/test/files.test.ts`). Project-wide `GET /v1/files` remains unpinned-only.
- Trigger polling still needs distributed leases, replay/backfill, provider-native signature verification, and an atomic claim/outbox. The Postgres execution/webhook, voice-agent, `voice_agent_session_observers`, `voice_webhook_sources`, and MCP session/task stores still need production backup/restore drills and multi-replica load/chaos evidence. Production monitoring must alert on queue age, observer retry age, exhausted observers, exhausted-but-unsignaled observers, repeated lease takeover, voice-source invariant misses, and exhausted webhook deliveries.
- The Activepieces bridge remains a private selective-promotion spike. Resolve its expression-engine advisories, license provenance, isolation/egress, auth mapping, and per-piece mock/real certification before exposing it.

After any remediation, update docs/SECURITY.md and CLAUDE.md, add the adversarial regression test, and rerun pnpm build, pnpm test, pnpm typecheck, pnpm lint, the four docs validators, pnpm test:contract, and the applicable cloud/worker gates serially.
