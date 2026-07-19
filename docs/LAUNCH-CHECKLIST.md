# 0.2.0 launch checklist

This checklist separates the completed source cut from work that requires an external account, credential, legal decision, deployment target, or live provider. Version 0.2.0 is not a claim that packages or hosted services are public.

For local Node and pnpm commands, preserve the release-review memory limits:

~~~sh
export PATH="/opt/homebrew/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=2048"
export VITEST_MAX_THREADS=1
~~~

## Done in source

- [x] Cross-repository claims reconciled against executed counts: 37 manifests, 493 matrix rows (227 smoke and 266 explicit not_supported), 112 documentation pages, 30 Mockhouse providers, and 164 Mockhouse tests.
- [x] RFC 001–004 authority and cross-references aligned with staged files, webhooks, triggers, durable stores, MCP Tasks, and the remote voice worker.
- [x] Generated SDK pages and catalog-owned toolkit pages checked for drift.
- [x] Five high-risk seams reviewed adversarially: development voice auth, staged-file scoping, MCP Tasks identity, webhook SSRF, and cloud API-key verification. The review found and fixed the staged-upload pre-buffer gap as SEC-021.
- [x] Main, cloud, and read-only Mockhouse gates run serially; the 493-row account-free contract matrix and ten-test Python worker suite pass.
- [x] Root plus @eyeball/core, @eyeball/catalog, @eyeball/toolkits, and @eyeball/sdk cut to 0.2.0; package and root changelogs generated or written.
- [x] Release tarballs constrained to the four public packages and inspected with the non-publishing dry run; compressed sizes are 26–182 KiB, below the 2 MiB ceiling.

## User-blocked launch actions

### 1. Configure Git remotes and push

Neither writable repository had a remote during the final review. The public package manifests identify eyeball-ai/eyeball as the canonical main repository; the private cloud repository URL must be supplied by its owner.

~~~sh
git -C /Users/khalidsh/eyeball remote add origin git@github.com:eyeball-ai/eyeball.git
git -C /Users/khalidsh/eyeball push -u origin main
git -C /Users/khalidsh/eyeball/cloud remote add origin <private-cloud-git-url>
git -C /Users/khalidsh/eyeball/cloud push -u origin main
~~~

If a remote already exists by the time this is run, verify it with git remote -v and use git remote set-url origin only after confirming ownership.

### 2. Finalize the public license

Counsel must supply the exact approved text and redistribution terms. Replace the root and four public-package license copies, then rerun the release boundary checks:

~~~sh
pnpm test:release
pnpm release:build
pnpm release:dry-run
git add LICENSE.md packages/core/LICENSE.md packages/catalog/LICENSE.md packages/toolkits/LICENSE.md packages/sdk/LICENSE.md docs/RELEASING.md
git commit -m "legal: finalize public package license"
~~~

Do not publish while docs/RELEASING.md still describes the license as a legal-review placeholder.

### 3. Provision the npm organization and publish

After the reviewed commit and final license are on GitHub, an @eyeball organization owner must grant package-publish access and create an automation token for the protected npm GitHub environment:

~~~sh
npm whoami
npm access list packages @eyeball
gh secret set NPM_TOKEN --repo eyeball-ai/eyeball --env npm
gh workflow run Release --repo eyeball-ai/eyeball --ref main -f confirm=publish
npm view @eyeball/core@0.2.0 version
npm view @eyeball/catalog@0.2.0 version
npm view @eyeball/toolkits@0.2.0 version
npm view @eyeball/sdk@0.2.0 version
~~~

The workflow, not a local shell, performs the real publish with npm provenance. Only update public claims after all four registry queries return 0.2.0 and their provenance attestations are visible.

### 4. Run real-provider certification

Create dedicated vendor tenants and supply each selected provider's documented base URL, credential fields, and fixture values. Run small provider batches so cleanup and evidence remain attributable:

~~~sh
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='<comma-separated-slugs>' pnpm test:contract
~~~

Required variables are EYEBALL_REAL_<TOOLKIT>_BASE_URL, auth-specific EYEBALL_CRED_<TOOLKIT>_* values, and any fixture variables named by a skip reason. A skipped row is not a pass. Record sanitized run URLs, catalog/manifest versions, vendor API versions, cleanup results, and quirks in docs/CERTIFICATION.md only after the real run succeeds.

### 5. Deploy and initialize the private cloud

An owner must provide the private Vercel project, production Postgres database, KMS/backup operating model, domains, OAuth applications, and Stripe account. Configure at least DATABASE_URL, SESSION_SECRET, INTERNAL_API_SECRET, VAULT_MASTER_KEY, OAUTH_INTENT_SECRET, OAUTH_CALLBACK_URL, STRIPE_SECRET_KEY, and STRIPE_WEBHOOK_SECRET, then run:

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
pnpm --dir /Users/khalidsh/eyeball/cloud build
vercel --cwd /Users/khalidsh/eyeball/cloud deploy --prod
pnpm --dir /Users/khalidsh/eyeball/cloud billing:bootstrap
~~~

The billing bootstrap command must run from an authenticated operator environment containing the same production database and Stripe variables. Configure Stripe webhook events and the external usage snapshot/period-close scheduler described in cloud/README.md; perform restore, KEK rotation, OAuth, key export/verify, Checkout, Portal, webhook, and delinquency-policy drills before claiming availability.

### 6. Validate live voice paths

Create a dedicated single-Machine Fly deployment with a durable SQLite volume and one user-pinned executor key. The static worker key is not a multi-user authority model.

~~~sh
fly volumes create voice_worker_data --region <region> --size 10 --app <app>
fly secrets set --app <app> EYEBALL_VOICE_WORKER_TOKEN='...' EYEBALL_VOICE_WORKER_KEY='...' EYEBALL_EXECUTOR_URL='https://executor.example.com' EYEBALL_VOICE_PUBLIC_URL='https://<app>.fly.dev' ANTHROPIC_API_KEY='...' DEEPGRAM_API_KEY='...' ELEVENLABS_API_KEY='...' TWILIO_ACCOUNT_SID='...' TWILIO_AUTH_TOKEN='...' TWILIO_FROM_NUMBER='...' LIVEKIT_URL='...' LIVEKIT_API_KEY='...' LIVEKIT_API_SECRET='...'
fly deploy --config /Users/khalidsh/eyeball/apps/voice-worker/fly.toml --app <app> --region <region>
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='deepgram,elevenlabs,livekit,pipecat,twilio,voice-agents' pnpm test:contract
~~~

Retain sanitized evidence for one outbound PSTN call, one inbound call if offered, one LiveKit/WebRTC session, speech-to-text, model turn, text-to-speech, child execution identity/retry, webhook delivery, restart recovery, and cleanup. Do not describe the path as certified until those checks pass.

## Engineering-deferred gates

These are neither account setup nor release ceremony; they require code or operations work and must remain visible in launch decisions:

- SEC-002 P1: webhook delivery blocks literal private targets and redirects but does not resolve and pin DNS. Hosted webhook egress needs resolver-aware IP classification on every connection plus network-layer deny policy.
- SEC-017 P1: staged files are project-scoped bearer capabilities, not user-owned records. Hosted multi-user use needs owner identity in the contract/store and checks on metadata and adapter byte resolution.
- SEC-004 P1: one static voice-worker bearer/key controls a worker. Keep one worker per trusted pinned user until short-lived session-scoped authority or tenant isolation exists.
- Trigger polling still needs distributed leases, replay/backfill, provider-native signature verification, and an atomic claim/outbox. Webhook retry scheduling, MCP sessions/tasks, voice-agent definitions, and remote voice-event observation retain documented process-local restart limits.
- The Activepieces bridge remains a private selective-promotion spike. Resolve its expression-engine advisories, license provenance, isolation/egress, auth mapping, and per-piece mock/real certification before exposing it.

After any remediation, update docs/SECURITY.md and CLAUDE.md, add the adversarial regression test, and rerun pnpm build, pnpm test, pnpm typecheck, pnpm lint, the four docs validators, pnpm test:contract, and the applicable cloud/worker gates serially.
