# Real authentication and provider certification

- Status: OSS single-tenant implementation and launch-certification runbook
- Scope: local/self-hosted Eyeball plus the manual real-target contract workflow
- Out of scope: hosted multi-user connection ownership, which belongs to the private Eyeball Cloud vault

Real authentication is the final provider step. Keep canonical requests, adapters, fixtures, and assertions unchanged;
select the real target for one provider batch, supply a dedicated tenant and credentials, and record the result in
[CERTIFICATION.md](./CERTIFICATION.md). The local vault is the durable OSS credential path. The static environment
provider remains the deliberately narrow input to the real-target certification runner.

## 1. Select a credential provider

The executor chooses credentials in this order:

1. An `ExecutionEngine` explicitly injected by the caller owns its credential provider.
2. The development fixture vault supplied to `createExecutorApp` takes precedence for the development-only routes.
3. Otherwise, `EYEBALL_CREDENTIALS` selects `mock`, `env`, or `local-vault`. Omitted means `mock`; there is no fallback
   from a selected provider when its configuration is incomplete.

| `EYEBALL_CREDENTIALS` | Required environment | Intended use |
|---|---|---|
| `mock` or omitted | none | deterministic tests and local fixture development |
| `env` | `EYEBALL_PROJECT_ID`, `EYEBALL_USER_ID`, and `EYEBALL_CRED_<TOOLKIT>_*` | one process-wide project/user; static certification credentials |
| `local-vault` | `EYEBALL_PROJECT_ID`, `EYEBALL_VAULT_PATH`, `EYEBALL_VAULT_KEY` | durable OSS/self-host credentials; users and connections are records |

Example self-host configuration:

```bash
export EYEBALL_CREDENTIALS=local-vault
export EYEBALL_PROJECT_ID=local-project
export EYEBALL_VAULT_PATH="$PWD/.eyeball/vault.json"
export EYEBALL_VAULT_KEY='<32-byte-base64-key>'
pnpm --filter @eyeball/executor dev
```

`EYEBALL_VAULT_KEY` must decode to exactly 32 bytes. Store it separately in the process secret manager. Losing it makes
the vault unrecoverable; exposing it exposes every record. Do not commit the key or vault.

## 2. Local vault design and operations

`LocalVaultCredentialProvider` lives in `packages/core` because credential selection and refresh are runtime contracts,
not executor HTTP behavior. OAuth endpoint/client metadata lives in `packages/catalog/src/oauth.ts` so the CLI and
executor use the same source.

The JSON file contains a format version, random vault salt, non-secret record selectors, monotonically increasing record
revisions, fresh per-write nonce seeds, and AES-256-GCM ciphertext/tag pairs. Each record nonce is derived with
HMAC-SHA-256 from the vault key, salt, record identity, revision, and fresh seed; delete/recreate cannot reuse a nonce. The
authenticated additional data covers the format version, identity, selector, revision, and seed. Access tokens, refresh
tokens, API keys, Basic passwords, OAuth client IDs/secrets, and token metadata are never written in plaintext. Writes use
a same-directory temporary file, `fsync`, atomic rename, and mode `0600`.

Writes and refreshes are serialized within one process. Concurrent callers resolving the same expired record share one
in-flight refresh. This is intentionally a single-process/single-tenant store: do not point multiple executor processes
at the same file. Use Eyeball Cloud for hosted multi-user connection ownership and distributed refresh.

The authenticated records detect ciphertext tampering but do not provide external monotonic rollback detection. Restore
only trusted backups, and revoke or rotate credentials at the upstream provider as well as deleting them locally; a copied
older vault file can otherwise restore an older, still-valid credential.

### 2.1 CLI quickstart

```bash
# Refuses to overwrite an existing vault. Capture both export lines securely.
pnpm eyeball-auth init --vault .eyeball/vault.json

export EYEBALL_VAULT_KEY='...output from init...'
export EYEBALL_VAULT_PATH="$PWD/.eyeball/vault.json"

pnpm eyeball-auth list
pnpm eyeball-auth list --user local-user --json
pnpm eyeball-auth remove gmail --user local-user
```

API-key and Basic examples:

```bash
pnpm eyeball-auth add stripe --user local-user --secret 'apiKey=sk_live_...'
pnpm eyeball-auth add twilio --user local-user --username 'AC...' --secret 'auth-token'
pnpm eyeball-auth add odoo --user local-user --username 'operator@example.com' \
  --secret 'api-key' --parameter 'database=production'
```

Omit `--secret` to prompt. Multi-field API credentials use one `--secret field=value` per manifest field. Named records
add `--connection conn_name`; omit it for the default connection.

### 2.2 OAuth connect flow

Create a web/installed OAuth app, register the callback (default `http://127.0.0.1:53682/callback`), then set its client
credentials. The client secret is prompted when omitted.

```bash
export EYEBALL_OAUTH_GMAIL_CLIENT_ID='...'
export EYEBALL_OAUTH_GMAIL_CLIENT_SECRET='...'
pnpm eyeball-auth add gmail --user local-user
```

The CLI prints the full authorize URL before waiting. It first attempts loopback capture; if the bind fails, it falls back
to a prompt. `--manual` always selects paste mode directly: authorize in any browser and paste the complete final redirect
URL, including `code` and `state`. `--redirect-uri` changes the registered callback. `--public-client` is available for a
provider-approved public client without a secret.

The authorization code is exchanged immediately. The encrypted record stores access/refresh tokens, expiry, scopes,
token type, client settings, and redirect URI. On expiry, `resolve` posts the refresh grant, persists any rotated refresh
token, and returns the fresh access token. A rejected refresh grant becomes non-retryable `auth_expired` with a reconnect
command; transport failures, HTTP 429, and provider 5xx responses become retryable `provider_unavailable`. Provider response
bodies are not exposed.

Use a production read-only canonical call as a final local check:

```bash
pnpm eyeball-auth test gmail --user local-user \
  --tool gmail.list_emails --input '{"pageSize":1}'
```

`test` resolves through the vault and executes only a synchronous tool annotated `readOnly`. If an empty object does not
satisfy a provider's schema, pass `--tool` and `--input`. Production manifest base URLs are used by default; set the
manifest override such as `EYEBALL_ZENDESK_BASE_URL=https://acme.zendesk.com` when the provider is tenant-scoped.

### 2.3 Voice-worker service identity

The separately deployed `apps/voice-worker` has two credentials with opposite trust directions. `EYEBALL_VOICE_WORKER_TOKEN`
is a shared bearer secret sent by the executor to the worker's versioned session API. `EYEBALL_VOICE_WORKER_KEY` is an
executor API key used by the worker when an allowlisted model tool call re-enters `/v1/execute`.

The worker key MUST be pinned to both project and user in `EYEBALL_API_KEYS`:

```bash
export EYEBALL_API_KEYS='ey_project:proj_local,ey_voice_worker:proj_local:diner_123'
export EYEBALL_VOICE_WORKER_URL='https://voice-worker.example.com'
export EYEBALL_VOICE_WORKER_TOKEN='replace-with-at-least-32-random-bytes'

# Worker process / secret manager:
export EYEBALL_EXECUTOR_URL='https://executor.example.com'
export EYEBALL_VOICE_WORKER_KEY='ey_voice_worker'
export EYEBALL_VOICE_WORKER_TOKEN='replace-with-at-least-32-random-bytes'
```

Only a user-pinned key may submit the reserved `X-Eyeball-Execution-Id` header, and then only with synchronous mode and an
`Idempotency-Key`. The worker commits the canonical call and stable execution identity before dispatch. Recovery reuses
that identity and `voice-session:<sessionId>:event:<sequence>`, so executor-level replay prevents a duplicate provider side
effect.

A future hosted executor that resolves project keys dynamically must call the
cloud control plane with `POST /internal/keys/verify`, an internal bearer
credential, and `{ "key": "..." }` in the JSON body. API keys must never be
placed in a query parameter or request target; request-body logging must remain
disabled on both sides of that internal boundary. The cloud endpoint limits the
raw body to 4 KiB before buffering and the candidate key to 1,024 characters.

Do not reuse the project-wide administrative key as the worker key, expose either service credential to a browser, or place
the control token in a Twilio URL directly. Twilio media URLs contain only an HMAC-derived, session-bound token. One static
worker key represents one user; a multi-user hosted worker requires short-lived per-session executor authorization that this
open-core implementation does not provide.

Anthropic, Deepgram, ElevenLabs, Twilio, and LiveKit credentials are deployment secrets for the provider-integration process and are not
stored in session snapshots or SQLite events. Canonical child-tool credentials such as Gmail continue to resolve through the
normal executor `CredentialProvider`. The `fake` worker mode exercises the control-plane event contract and mocked
executor-reentry behavior with no third-party credentials, but it is rejected unless explicitly enabled for tests. These
tests do not place a call, open a media socket, or certify any provider SDK or live credential.

## 3. OAuth metadata

The following endpoints are grounded in the linked provider documentation as of 2026-07-17 except the explicitly marked
Airtable row. An uncertain endpoint must use `endpointVerification: "todo-verify"` and must not be called a
production-ready connection until verified against the provider's current authoritative reference.

| Toolkit | Authorization endpoint | Token endpoint | App setup / authoritative reference | Status |
|---|---|---|---|---|
| `airtable` | `https://airtable.com/oauth2/v1/authorize` | `https://airtable.com/oauth2/v1/token` | [Airtable OAuth reference](https://airtable.com/developers/web/api/oauth-reference), [Builder Hub guide](https://support.airtable.com/docs/using-builder-hub-in-airtable) | **TODO-verify** — official reference is client-rendered and could not be independently captured in the no-egress environment; verify endpoints and PKCE S256 before production |
| `github` | `https://github.com/login/oauth/authorize` | `https://github.com/login/oauth/access_token` | [GitHub OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [Developer settings](https://github.com/settings/developers) | grounded |
| `gmail`, `google-calendar`, `google-drive`, `google-sheets` | `https://accounts.google.com/o/oauth2/v2/auth` | `https://oauth2.googleapis.com/token` | [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Cloud credentials](https://console.cloud.google.com/apis/credentials) | grounded |
| `linear` | `https://linear.app/oauth/authorize` | `https://api.linear.app/oauth/token` | [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication), create an OAuth application in the workspace API settings | grounded |
| `microsoft-outlook` | `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` | `https://login.microsoftonline.com/common/oauth2/v2.0/token` | [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) | grounded |
| `notion` | `https://api.notion.com/v1/oauth/authorize` | `https://api.notion.com/v1/oauth/token` | [Notion public integration authorization](https://developers.notion.com/guides/get-started/authorization), [My integrations](https://www.notion.so/profile/integrations) | grounded |
| `shopify` | `https://{shop}.myshopify.com/admin/oauth/authorize` | `https://{shop}.myshopify.com/admin/oauth/access_token` | [Shopify authorization-code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant), create the app in the [Dev Dashboard](https://dev.shopify.com/dashboard) | grounded |
| `slack` | `https://slack.com/oauth/v2/authorize` | `https://slack.com/api/oauth.v2.access` | [Slack OAuth v2](https://api.slack.com/authentication/oauth-v2), [Slack apps](https://api.slack.com/apps) | grounded |
| `hubspot` | `https://app.hubspot.com/oauth/authorize` | `https://api.hubspot.com/oauth/2026-03/token` | [HubSpot OAuth token management](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens), [HubSpot developer projects](https://developers.hubspot.com/) | grounded |
| `quickbooks` | `https://appcenter.intuit.com/connect/oauth2` | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` | [Intuit OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0), [Intuit developer dashboard](https://developer.intuit.com/app/developer/dashboard) | grounded |
| `zendesk` | `https://{subdomain}.zendesk.com/oauth/authorizations/new` | `https://{subdomain}.zendesk.com/oauth/tokens` | [Zendesk OAuth clients](https://developer.zendesk.com/documentation/api-basics/authentication/api-tokens-to-oauth/) | grounded |

Client environment names are `EYEBALL_OAUTH_<TOOLKIT>_CLIENT_ID` and
`EYEBALL_OAUTH_<TOOLKIT>_CLIENT_SECRET`. Zendesk additionally requires
`EYEBALL_OAUTH_ZENDESK_SUBDOMAIN`; Shopify requires `EYEBALL_OAUTH_SHOPIFY_SHOP`. Airtable uses PKCE S256. Airtable,
QuickBooks, and Notion use HTTP Basic client authentication; Notion and Zendesk use JSON token requests. Shopify validates
the callback HMAC before exchanging the provider-specific authorization-code request. The other configured providers use
form-encoded token requests.

## 4. Real-target certification batches

Warning: the contract suite contains mutating cases. Run it only in a dedicated disposable/sandbox tenant, review fixture
IDs, enable the GitHub Environment approval gate, and clean up after the run. `eyeball-auth test` is the read-only
credential probe; it is not a substitute for the complete contract suite.

Every OAuth real target uses these three credential variables, with the toolkit slug uppercased and hyphens changed to
underscores:

```text
EYEBALL_CRED_<TOOLKIT>_ACCESS_TOKEN   fresh provider access token
EYEBALL_CRED_<TOOLKIT>_EXPIRES_AT    ISO-8601 expiry after the planned run
EYEBALL_CRED_<TOOLKIT>_SCOPES        space- or comma-separated granted scopes
```

The real-target runner intentionally uses `EnvCredentialProvider`; it does not refresh. Obtain a fresh token from the
approved app flow immediately before the run. The local CLI never prints stored tokens back out, so transfer tokens into
CI through the provider callback/token process and the GitHub Environment secret manager, not by scraping the vault.

### 4.1 Google batch

Provision one Google Cloud project, enable the Gmail, Calendar, Drive, and Sheets APIs, configure the consent screen, and
create OAuth credentials in the [Google Cloud console](https://console.cloud.google.com/apis/credentials). Use a dedicated
test account and the scopes declared in `packages/catalog/src/oauth.ts`.

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `gmail` | `EYEBALL_REAL_GMAIL_BASE_URL=https://gmail.googleapis.com` | `EYEBALL_CRED_GMAIL_ACCESS_TOKEN`, `EYEBALL_CRED_GMAIL_EXPIRES_AT`, `EYEBALL_CRED_GMAIL_SCOPES` | `EYEBALL_REAL_GMAIL_MESSAGE_ID` |
| `google-calendar` | `EYEBALL_REAL_GOOGLE_CALENDAR_BASE_URL=https://www.googleapis.com` | `EYEBALL_CRED_GOOGLE_CALENDAR_ACCESS_TOKEN`, `EYEBALL_CRED_GOOGLE_CALENDAR_EXPIRES_AT`, `EYEBALL_CRED_GOOGLE_CALENDAR_SCOPES` | `EYEBALL_REAL_GOOGLE_CALENDAR_CALENDAR_ID`, `EYEBALL_REAL_GOOGLE_CALENDAR_EVENT_ID`, `EYEBALL_REAL_GOOGLE_CALENDAR_ATTENDEE_EMAIL` |
| `google-drive` | `EYEBALL_REAL_GOOGLE_DRIVE_BASE_URL=https://www.googleapis.com` | `EYEBALL_CRED_GOOGLE_DRIVE_ACCESS_TOKEN`, `EYEBALL_CRED_GOOGLE_DRIVE_EXPIRES_AT`, `EYEBALL_CRED_GOOGLE_DRIVE_SCOPES` | `EYEBALL_REAL_GOOGLE_DRIVE_DELETE_FILE_ID`, `EYEBALL_REAL_GOOGLE_DRIVE_FILE_ID`, `EYEBALL_REAL_GOOGLE_DRIVE_DOCUMENT_ID`, `EYEBALL_REAL_GOOGLE_DRIVE_MOVE_FILE_ID`, `EYEBALL_REAL_GOOGLE_DRIVE_FOLDER_ID` |
| `google-sheets` | `EYEBALL_REAL_GOOGLE_SHEETS_BASE_URL=https://sheets.googleapis.com` | `EYEBALL_CRED_GOOGLE_SHEETS_ACCESS_TOKEN`, `EYEBALL_CRED_GOOGLE_SHEETS_EXPIRES_AT`, `EYEBALL_CRED_GOOGLE_SHEETS_SCOPES` | `EYEBALL_REAL_GOOGLE_SHEETS_DOCUMENT_ID`, `EYEBALL_REAL_GOOGLE_SHEETS_RANGE`, `EYEBALL_REAL_GOOGLE_SHEETS_ROW_ID`, `EYEBALL_REAL_GOOGLE_SHEETS_UPDATE_RANGE` |

```bash
EYEBALL_CONTRACT_TARGET=real \
EYEBALL_CONTRACT_PROVIDERS='gmail,google-calendar,google-drive,google-sheets' \
pnpm test:contract
```

### 4.2 Microsoft batch

Register an application under [Microsoft Entra app registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade),
add the registered callback, and grant the delegated Graph mail scopes shown in the OAuth metadata. Use a dedicated test
mailbox.

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `microsoft-outlook` | `EYEBALL_REAL_MICROSOFT_OUTLOOK_BASE_URL=https://graph.microsoft.com` | `EYEBALL_CRED_MICROSOFT_OUTLOOK_ACCESS_TOKEN`, `EYEBALL_CRED_MICROSOFT_OUTLOOK_EXPIRES_AT`, `EYEBALL_CRED_MICROSOFT_OUTLOOK_SCOPES` | `EYEBALL_REAL_MICROSOFT_OUTLOOK_MESSAGE_ID` |

```bash
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='microsoft-outlook' pnpm test:contract
```

### 4.3 Slack batch

Create/install an app at [Slack apps](https://api.slack.com/apps), register the callback, add the configured bot scopes,
and use a dedicated workspace/channel with a seeded message.

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `slack` | `EYEBALL_REAL_SLACK_BASE_URL=https://slack.com` | `EYEBALL_CRED_SLACK_ACCESS_TOKEN`, `EYEBALL_CRED_SLACK_EXPIRES_AT`, `EYEBALL_CRED_SLACK_SCOPES` | `EYEBALL_REAL_SLACK_CONVERSATION_ID`, `EYEBALL_REAL_SLACK_MESSAGE_ID` |

```bash
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='slack' pnpm test:contract
```

### 4.4 Business batch

- HubSpot: create a public app/project from the [HubSpot developer portal](https://developers.hubspot.com/), add the
  configured CRM scopes, and seed contact/company/deal IDs in a developer test account.
- QuickBooks: create an app in the [Intuit developer dashboard](https://developer.intuit.com/app/developer/dashboard),
  connect its sandbox company with the accounting scope, and record the company `realmId` plus sandbox customer/invoice
  IDs.
- Zendesk: create an OAuth client under the tenant's Admin Center following the
  [official OAuth-client guide](https://developer.zendesk.com/documentation/api-basics/authentication/api-tokens-to-oauth/),
  then seed a ticket, assignee, and conversation in a non-production tenant.

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `hubspot` | `EYEBALL_REAL_HUBSPOT_BASE_URL=https://api.hubapi.com` | `EYEBALL_CRED_HUBSPOT_ACCESS_TOKEN`, `EYEBALL_CRED_HUBSPOT_EXPIRES_AT`, `EYEBALL_CRED_HUBSPOT_SCOPES` | `EYEBALL_REAL_HUBSPOT_CONTACT_ID`, `EYEBALL_REAL_HUBSPOT_COMPANY_ID`, `EYEBALL_REAL_HUBSPOT_DEAL_ID` |
| `quickbooks` | `EYEBALL_REAL_QUICKBOOKS_BASE_URL=https://quickbooks.api.intuit.com` | `EYEBALL_CRED_QUICKBOOKS_ACCESS_TOKEN`, `EYEBALL_CRED_QUICKBOOKS_EXPIRES_AT`, `EYEBALL_CRED_QUICKBOOKS_SCOPES` | `EYEBALL_REAL_QUICKBOOKS_REALM_ID`, `EYEBALL_REAL_QUICKBOOKS_CUSTOMER_ID`, `EYEBALL_REAL_QUICKBOOKS_INVOICE_ID` |
| `zendesk` | `EYEBALL_REAL_ZENDESK_BASE_URL=https://<subdomain>.zendesk.com` | `EYEBALL_CRED_ZENDESK_ACCESS_TOKEN`, `EYEBALL_CRED_ZENDESK_EXPIRES_AT`, `EYEBALL_CRED_ZENDESK_SCOPES` | `EYEBALL_REAL_ZENDESK_TICKET_ID`, `EYEBALL_REAL_ZENDESK_ASSIGNEE_ID`, `EYEBALL_REAL_ZENDESK_CONVERSATION_ID` |

```bash
EYEBALL_CONTRACT_TARGET=real \
EYEBALL_CONTRACT_PROVIDERS='hubspot,quickbooks,zendesk' \
pnpm test:contract
```

### 4.5 Productivity batch

- Airtable: create an OAuth integration following the [Builder Hub guide](https://support.airtable.com/docs/using-builder-hub-in-airtable), seed a base containing a
  `Tasks` table, and do not clear the OAuth metadata's **TODO-verify** status until the current official reference has been
  checked interactively.
- GitHub: create an OAuth app under [Developer settings](https://github.com/settings/developers) and use a disposable test
  repository with Issues enabled.
- Linear: create an OAuth application in the workspace API settings following the
  [official OAuth guide](https://linear.app/developers/oauth-2-0-authentication) and use a disposable team/project.
- Notion: create a public integration under [My integrations](https://www.notion.so/profile/integrations), share a test
  data source with it, and follow the [official authorization guide](https://developers.notion.com/guides/get-started/authorization).

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `airtable` | `EYEBALL_REAL_AIRTABLE_BASE_URL=https://api.airtable.com` | `EYEBALL_CRED_AIRTABLE_ACCESS_TOKEN`, `EYEBALL_CRED_AIRTABLE_EXPIRES_AT`, `EYEBALL_CRED_AIRTABLE_SCOPES` | `EYEBALL_REAL_AIRTABLE_DOCUMENT_ID`, `EYEBALL_REAL_AIRTABLE_ROW_ID`; the base must contain a table named `Tasks` |
| `github` | `EYEBALL_REAL_GITHUB_BASE_URL=https://api.github.com` | `EYEBALL_CRED_GITHUB_ACCESS_TOKEN`, `EYEBALL_CRED_GITHUB_EXPIRES_AT`, `EYEBALL_CRED_GITHUB_SCOPES` | `EYEBALL_REAL_GITHUB_PROJECT_ID` (`owner/repo`), `EYEBALL_REAL_GITHUB_ISSUE_ID`, `EYEBALL_REAL_GITHUB_PULL_REQUEST_ID` |
| `linear` | `EYEBALL_REAL_LINEAR_BASE_URL=https://api.linear.app` | `EYEBALL_CRED_LINEAR_ACCESS_TOKEN`, `EYEBALL_CRED_LINEAR_EXPIRES_AT`, `EYEBALL_CRED_LINEAR_SCOPES` | `EYEBALL_REAL_LINEAR_PROJECT_ID`, `EYEBALL_REAL_LINEAR_ISSUE_ID` |
| `notion` | `EYEBALL_REAL_NOTION_BASE_URL=https://api.notion.com` | `EYEBALL_CRED_NOTION_ACCESS_TOKEN`, `EYEBALL_CRED_NOTION_EXPIRES_AT`, `EYEBALL_CRED_NOTION_SCOPES` | `EYEBALL_REAL_NOTION_DOCUMENT_ID`, `EYEBALL_REAL_NOTION_ROW_ID` |

```bash
EYEBALL_CONTRACT_TARGET=real \
EYEBALL_CONTRACT_PROVIDERS='airtable,github,linear,notion' \
pnpm test:contract
```

### 4.6 Commerce batch

Create an app in the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), configure the callback and declared Admin
API scopes, install it in a development store, request expiring offline access, and seed disposable product/order/customer
records. The callback is accepted only when its Shopify HMAC and `shop` tenant match.

| Provider | Exact base URL variable | Exact credential variables | Exact real fixture variables |
|---|---|---|---|
| `shopify` | `EYEBALL_REAL_SHOPIFY_BASE_URL=https://<shop>.myshopify.com` | `EYEBALL_CRED_SHOPIFY_ACCESS_TOKEN`, `EYEBALL_CRED_SHOPIFY_EXPIRES_AT`, `EYEBALL_CRED_SHOPIFY_SCOPES` | `EYEBALL_REAL_SHOPIFY_ORDER_ID`, `EYEBALL_REAL_SHOPIFY_LINE_ITEM_ID`, `EYEBALL_REAL_SHOPIFY_PRODUCT_ID`, `EYEBALL_REAL_SHOPIFY_INVENTORY_ITEM_ID`, `EYEBALL_REAL_SHOPIFY_LOCATION_ID` |

```bash
EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='shopify' pnpm test:contract
```

### 4.7 Manual CI dispatch

`.github/workflows/contract-real.yml` exposes `google`, `microsoft`, `slack`, `business`, `productivity`, and `commerce`
choices. Create a protected GitHub Environment named `real-auth-<batch>` for each one; add the exact non-base variables
above as Environment secrets (plus the tenant-specific Zendesk and Shopify base URLs). The workflow validates every
required value before running, selects only the batch's provider slugs, rejects skipped/failed report rows, and uploads the
sanitized `contract-report.json` artifact. The workflow certifies the Airtable adapter but its CLI OAuth metadata remains
**TODO-verify** until the separate endpoint check above is complete.

## 5. Recording certification and mock drift

After a complete green run:

1. Open `apps/executor/contract-report.json` and confirm `target: "real"`, no `fail` or `skipped` matrix outcomes, and all
   shared assertions passed. `not_supported` is expected only for tools the provider manifest intentionally omits.
2. Clean up all created provider resources and retain only sanitized evidence.
3. Update the provider rows in [CERTIFICATION.md](./CERTIFICATION.md) with suite version, UTC date, linked workflow run or
   evidence artifact, result, vendor API version, manifest/mock version, cleanup status, and quirk IDs or `none`.
4. Mark launch-certified only after the corresponding mock target and real target are green.

A real failure is provider evidence, not permission to change target-specific assertions. Classify the failure, add a
sanitized quirk entry with reproduction date and scope, correct the adapter if its wire behavior is wrong, and update the
separate `eyeball-mocks` repository to match observed reality. Add/regress the same contract against the mock, rerun mock
and real targets, then record a new green certification. Never invent provider behavior in the mock and never weaken a
canonical contract only for the real target.
