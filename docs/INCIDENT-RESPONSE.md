# Incident response

This is the minimum incident-response skeleton for Eyeball. It must be paired
with named people, paging systems, legal/privacy contacts, infrastructure
inventory, and customer communication channels before a hosted launch.

## Severity

| Severity | Definition | Examples | Target response |
| --- | --- | --- | --- |
| SEV-1 Critical | Active or credible compromise with broad tenant, credential, code-execution, or availability impact. | KEK plus database compromise; signing/release compromise; cross-tenant credential access; active secret exfiltration; destructive outage without a safe workaround. | Page immediately; incident commander in 15 minutes; executive/security/legal notification in the first hour. |
| SEV-2 High | Confirmed material compromise or outage with bounded scope and no evidence of broad spread. | One tenant's API key leaked; webhook SSRF reaches an internal target; OAuth token exposure; prolonged regional failure. | Page immediately; owner in 30 minutes; incident channel and containment in the first hour. |
| SEV-3 Medium | Security control failure with limited current impact or a contained degradation. | Redaction regression in a restricted log, replayable internal request with no observed abuse, delayed webhook/trigger delivery. | Assign within four hours; contain the same business day. |
| SEV-4 Low | Hardening issue, policy gap, or unsuccessful attempt without material impact. | Scanner false negative for a fake fixture, missing evidence, non-exploitable configuration drift. | Triage within two business days and track through normal remediation. |

Severity can only stay the same or increase until evidence establishes the
blast radius. Absence of logs is not evidence of absence.

## First hour

1. Start an incident record with an immutable UTC timeline; appoint incident
   commander, operations lead, communications lead, and scribe.
2. Preserve evidence before rotation or redeployment: relevant audit/log ranges,
   cloud/provider events, database snapshots, deployment digests, CI provenance,
   configuration versions, and affected object IDs. Do not copy plaintext
   secrets into the incident channel.
3. Classify the asset and boundary: browser/session, project API key, provider
   credential, webhook/trigger, voice, cloud internal API, KEK/database, CI, or
   dependency.
4. Contain the narrowest known boundary: disable a route or tenant, revoke a
   key, quarantine an instance, stop egress, pause releases, or isolate the
   database. Prefer reversible containment and record every operator action.
5. Determine earliest exposure, affected tenants/users/providers, whether data
   was read or modified, persistence/replay opportunities, and whether backups
   or logs contain the exposed material.
6. Notify the founder/security owner and, for SEV-1/SEV-2, engage legal/privacy,
   cyber-insurance, and relevant provider contacts. Do not speculate publicly.
7. Establish a 30-minute update cadence for SEV-1 and 60-minute cadence for
   SEV-2 until containment is stable.
8. Prepare customer guidance that identifies what to revoke and what evidence
   is known; never claim “no impact” from incomplete telemetry.

## Key-revocation and rotation runbook

Rotation order follows the compromise path, not a blind global sequence. First
revoke the credential that still gives the attacker access; then rotate secrets
the attacker could have read through that access. Preserve hashes/metadata
needed for forensics before destructive revocation.

### Default order for an application/control-plane compromise

1. **Contain interactive access:** revoke affected cloud sessions, operator
   tokens, deployment credentials, and CI/release credentials; isolate the
   compromised service and block suspicious egress.
2. **Internal service secrets:** rotate executor-to-cloud and other internal
   bearer/HMAC secrets. Deploy readers that accept old+new only for a bounded
   overlap, switch all writers, verify, then remove old. Treat requests captured
   under the old bearer as replayable.
3. **Webhook and trigger secrets:** rotate affected outbound webhook signing
   secrets and trigger-ingest URLs. Notify receivers of the exact cutover;
   trigger rotation invalidates the old URL immediately.
4. **Project/user API keys:** revoke exposed keys, issue reveal-once replacements,
   update dashboard/SDK/MCP/voice consumers, and verify pinned-user scope. Do not
   put replacements into tickets or chat.
5. **Provider credentials:** revoke API keys and OAuth grants at each provider,
   then reauthorize connections. Rotating only Eyeball's storage encryption does
   not invalidate an upstream token.
6. **Cloud session/OAuth signing and Stripe secrets:** rotate any material the
   compromised service could read, invalidate existing OAuth intents/state,
   confirm Stripe webhook endpoints, and deduplicate/reconcile events during
   cutover.
7. **KEK:** use the staged runbook below if KEK exposure is suspected or
   confirmed. Rotating a KEK is necessary for stored-ciphertext protection but
   does not replace upstream credential revocation.

### KEK compromise or cryptographic rotation

1. If the database may also be exposed, take a forensic snapshot under access
   control, block further reads, and assume every stored provider credential is
   compromised. Begin upstream revocation in parallel with containment.
2. Provision a new KEK version in the approved secret/KMS boundary. Never copy
   KEK bytes to the incident record.
3. Deploy a `KeyWrapperSet` that reads the old and new versions but writes only
   the new current version.
4. Run the transactional vault `rewrapAll` operation in bounded batches once an
   operator command exists; record expected, successful, and failed counts.
5. Verify every live encrypted data key declares the new wrapper version and
   sample decryption through the normal service path. Quarantine failures rather
   than deleting records.
6. Account for backups, replicas, exports, and disaster-recovery copies. Either
   rewrap them under a controlled restore procedure or expire/destroy them per
   policy before retiring the old KEK.
7. Remove old-key read access, destroy/disable the old KEK, monitor decryption
   failures, and attach rotation evidence to the incident.
8. Revoke and reauthorize upstream provider credentials if plaintext exposure
   was possible. A successful rewrap only protects ciphertext going forward.

The cloud implementation supports versioned read-many/write-current wrappers
and transactional rewrap, but an audited operator CLI/job is still missing. Do
not improvise direct database rewrites during an incident.

### Secret-specific notes

- **Local vault key:** stop the executor, preserve the vault file, generate a
  new 32-byte key, decrypt/re-encrypt through a reviewed migration, atomically
  replace the file, and revoke provider credentials if the old key and file may
  both have been exposed. The local vault cannot detect rollback to an older
  valid file.
- **Outbound webhook secret:** receivers may need an explicit dual-signature
  transition. Current rotation returns the replacement once; securely confirm
  receiver adoption.
- **Trigger secret:** use `POST /v1/subscriptions/:id/rotate-secret`; update the
  provider callback with the new create-time URL and verify the old URL returns
  not found.
- **Voice control token:** restart/redeploy every worker and client that shares
  the token. Assume all sessions on that worker were addressable while it was
  exposed; then rotate the worker's user-pinned executor key.
- **Stripe webhook secret:** create/activate the replacement at Stripe, allow a
  deliberately bounded verification overlap if implemented, reconcile stored
  event IDs, then remove the old endpoint secret.

## Investigation and recovery

- Build a scope list using project, user, connection, execution, webhook,
  trigger, session, provider, source IP, deployment, and event IDs. Use hashes
  or prefixes rather than plaintext credentials.
- Compare application, cloud audit, provider, database, proxy, CI, and release
  evidence. Explicitly record unavailable or process-local telemetry.
- Identify initial access, persistence, lateral movement, data accessed,
  modifications, replay, and recovery gaps. Validate assumptions with tests or
  isolated reproductions.
- Patch the root cause, add a regression test, rotate affected material, restore
  from a verified point, and monitor for recurrence before declaring recovery.
- Require incident-command approval to restore writes or credential resolution
  for SEV-1/SEV-2 incidents.
- Complete a blameless post-incident review with owner/dates for every action,
  control failure, missing evidence source, and customer follow-up.

## Disclosure and communication timeline

- Acknowledge a good-faith vulnerability report within one business day for a
  suspected critical issue and three business days otherwise.
- Give the reporter a triage status within seven calendar days where possible.
- Notify affected customers and regulators without undue delay after there is
  credible evidence and usable protective guidance; legal/privacy obligations
  and jurisdiction-specific deadlines override this baseline.
- For an actively exploited issue, prioritize containment and customer action
  over coordinated publication. For other issues, target coordinated disclosure
  within 90 days, with extensions only for clear safety reasons agreed with the
  reporter.
- Publish a factual advisory after remediation that covers affected versions,
  impact, mitigations, fixed versions/commits, and credit. Do not expose exploit
  details that would endanger unpatched users before a reasonable update window.
- Provide regular incident updates at the declared cadence and a final summary
  when scope, containment, and recovery are verified. Correct earlier statements
  promptly when evidence changes.

The placeholder vulnerability mailbox is documented in
[`SECURITY.md`](./SECURITY.md); it must be provisioned and monitored before this
timeline is presented as an operational commitment.
