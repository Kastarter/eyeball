# eyeball — Planned work

State as of 2026-07-21. The 0.2.0 source cut is complete, M5 is underway with
M5.1 complete, and two audit sweeps
(cross-feature wiring; dashboard/SDK/docs parity) produced a milestone-ordered
gap ledger. Milestones **M1 (hosted execution slice)**, **M2 (billing as a
product)**, **M3 (restart-state durability)**, and **M4 (voice hardening)** are
DONE. This file lists what
remains, in the intended order. Each item was scoped from audit findings with `file:line` evidence — search the
audit IDs (A-xx, SEC-xxx, CLOUD-xxx) in `docs/SECURITY.md`, `cloud/SECURITY.md`,
and the git history for full context.

Working conventions: see `CLAUDE.md` (both repos). Gates for every change:
build, test, typecheck, lint — serial (`turbo --concurrency=1`,
`VITEST_MAX_THREADS=1`), plus the four `docs:*` validators when docs/catalog
change. Never bind ports in tests; use in-process apps (`app.request`, PGlite).

## Done since 0.2.0 (context for what follows)

- M1.1 Hosted composition: async key auth, dynamic cloud key verification
  (fail-closed, 60s/5s TTLs), `EYEBALL_CREDENTIALS=cloud`.
- M1.2 Cloud usage atomicity: transactional reservations, free-cap races fixed.
- M1.3 Executor usage gate: reservation preflight + durable terminal outbox.
- M1.4 Cross-app hosted E2E (release-gate scenarios 1–5 automated).
- M1.5 SEC-022: strict usage enforcement default in hosted composition.
- M2.1 Stripe return routes + `DASHBOARD_PUBLIC_URL` split + portal-as-mutation.
- M2.2 Billing/usage UI, org members, BYO OAuth apps, redirect origins.
- M2.3 Lease-guarded jobs runner (refresh/snapshots/month-close/sweeps).
- M2.4 CLOUD-002 delinquency enforcement + operator exemption.
- M3.1 Durable serializable async queue, Postgres leases, and startup recovery
  for pending/running executions plus webhook selection/delivery work.
- M3.2 Durable FileStore and files list: Postgres `bytea` content behind the
  existing seam, durable runtime wiring, paginated `GET /v1/files`, and
  `eyeball.files.list`. Audit finding 8 + A-04.
- M3.3 Durable AgentStore + MCP SessionStore: async `AgentStore`; stable durable
  agent heads with immutable revisions; revision-pinned number bindings and
  executor session pointers; durable message receipts; one-way-bound durable MCP
  sessions/tasks; and zero-database memory fallbacks. Audit finding 7 tail.
  M3 closes restart-state loss for these records, not general multi-replica
  certification: distributed trigger polling, global rate/concurrency limits,
  backup/restore, and load/chaos evidence remain open.
- M4.1 Per-session executor grants: v2 worker contract; executor-owned session
  IDs; short-lived HMAC capabilities scoped to audience/project/user/session/
  expiry/tool allowlist; durable grant identity and revocation; terminal worker
  bearer erasure; static pinned-key fallback; and two-user isolation coverage.
  SEC-004 / audit finding 5.
- M4.2 Observer durability + transport error taxonomy: durable lease-fenced
  observer cursor/phase/retry records; source-first durable voice webhook
  envelopes; cursor checkpoints only after durable publication and terminal
  handling; boot reconciliation; terminal grant and complete-history transcript
  recovery; redacted deterministic exhaustion signaling; and structured driver
  kinds for retryable `provider_unavailable`/`timeout` versus non-retryable
  `invalid_response`. This closes cross-feature audit ordinals 9–10, which are
  not the unrelated `SEC-009` and `SEC-010` entries in `docs/SECURITY.md`. M4
  closes the defined hardening item, not live-provider certification,
  production backup/restore drills, or managed multi-replica load/chaos proof.
- M5.1 Webhooks page: project endpoint CRUD, catalog-backed event selection,
  ephemeral reveal-once create/rotation secrets, confirmed rotation/deletion,
  metadata-only paginated delivery attempts, and a dashboard executor proxy
  `PATCH` allowlist restricted to endpoint updates. A-01 closed.

## M5 — Local dashboard surfaces (demo mode; executor APIs mostly exist)

7. **M5.2 Triggers page.** Subscription CRUD, mode-specific forms, reveal-once
   push ingest URL, rotate, delete. A-02.
8. **M5.3 Files page + Try-It attachment picker.** Uses the completed M3.2
   file-list API.
   A-04.
9. **M5.4 Voice panel: WebRTC web-session test + Numbers section.** The stale
   WebRTC branch says activation is undefined although
   `voice-agents.create_web_session` shipped; number lifecycle tools have no
   UI. A-05, A-06.
10. **M5.5 Execution provenance + rate-limit visibility.** Safe replay
    metadata (never the raw idempotency key), voice-session source link on
    child executions, attachments summary (metadata only), fix
    `retryAfter` field mismatch and forward `RateLimit-*`/`Retry-After`
    through the proxy. A-07..A-10.
11. **M5.6 XS polish batch.** Drawer/search/connection error-state fidelity
    (A-11..A-14); **A-15: the overview quickstart sends `text` instead of
    `body` — the advertised first execution fails schema validation** (fix +
    source snippets from the catalog); stale MOCKS.md coverage note (D-01);
    mocks README test count 163→164 (D-02, edit inside `mocks/` repo); voice
    docs end-to-end snippets (C-01).
12. **M5.7 Trigger event history (L).** No queryable trigger-event API exists —
    add a redacted project-scoped `TriggerEventStore`, paginated
    `GET /v1/trigger-events`, SDK client, and a recent-events UI. A-03.

## M6 — Quality of life

13. **M6.1 Execution cancellation.** `POST /v1/executions/:id/cancel`
    (pending/queued; running is best-effort), MCP `tasks/cancel` wiring, SDK
    method. Unblocks the documented MCP limitation.
14. **M6.2 Readiness endpoint.** `/health` is liveness-only; add `/ready`
    failing closed on DB/migrations/credential-provider/queue admission.
    Audit finding 14.
15. **M6.3 Landing anchors + deploy manifests.** Fragment links break on legal
    pages (`site-chrome.tsx:18` → `/#providers`); add checked-in deploy
    manifests for control plane, dashboard, landing. Audit findings 16 + 6.

## Deferred by explicit founder decision

- **Python SDK** — post-launch fast-follow (MCP + REST cover Python users).
- **Activepieces bridge productization** — RFC 003 verdict: selective
  per-piece promotion only; requires an isolated piece-runner (egress
  enforcement below JS clients), per-piece certification, license provenance.
  Do not start without a founder go. Note SEC-003 (`expr-eval` advisories in
  the private spike) before any promotion.

## Security register — open engineering gates (see SECURITY.md files for detail)

- SEC-002 webhook DNS-rebinding-resistant delivery (resolve/pin at delivery).
- SEC-006/CLOUD-003 internal request anti-replay signing (timestamp/nonce/body
  digest) — the shared internal bearer is powerful.
- SEC-008 Slack provider-native signature verification for push ingest.
- SEC-010 Python worker hashed transitive locks + `pip-audit` in CI.
- SEC-017 staged-file per-user ownership (hosted multi-user gate).
- CLOUD-004 Postgres RLS defense-in-depth for tenancy.
- CLOUD-005 production KMS integration + rotation runbook operations.
- CLOUD-006 audit retention/alerting completeness.
- Distributed trigger polling leases, provider signature verification,
  replay/backfill; distributed rate limiting for multi-replica.

## Founder-blocked launch gates (docs/LAUNCH-CHECKLIST.md has exact commands)

1. Git remotes + push approval (this file ships with the first push).
2. Final license text (FSL placeholder pending legal review).
3. `@eyeball` npm organization + `NPM_TOKEN` + first publish.
4. Real-provider certification credentials (`docs/REAL-AUTH.md`).
5. Cloud production deployment (Vercel/Postgres/KMS/Stripe live mode + crons).
6. Voice live-call validation (Twilio/LiveKit/Deepgram/ElevenLabs/Anthropic).
7. Terms/Privacy final text; monitored security-reporting channel.
