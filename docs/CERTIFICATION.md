# Real-provider certification

Real-provider certification follows [TESTING.md §5](./TESTING.md#5-real-auth-certification-process) and the executable
[real-auth runbook](./REAL-AUTH.md). A row stays
`not yet certified` until the manifest-derived contract suite passes with `target=real` in a dedicated vendor tenant,
created resources are cleaned up, and sanitized evidence is retained. Certification evidence must link the run and
record suite, manifest/mock, and exposed vendor API versions without including credentials or customer data.

Run a filtered batch with `EYEBALL_CONTRACT_TARGET=real EYEBALL_CONTRACT_PROVIDERS='<comma-separated-slugs>' pnpm
test:contract`. Each selected provider requires
`EYEBALL_REAL_<TOOLKIT>_BASE_URL`, the auth-class-specific `EYEBALL_CRED_<TOOLKIT>_*` credential fields, and any
tenant fixture values named in the suite's skip reason. Missing configuration remains an explicit skipped row; it is
never interpreted as a certification pass.

| Provider | Suite version | Date | target=real result | Quirks |
|---|---|---|---|---|
| `airtable` | — | — | not yet certified | — |
| `deepgram` | — | — | not yet certified | — |
| `discord` | — | — | not yet certified | — |
| `elevenlabs` | — | — | not yet certified | — |
| `firecrawl` | — | — | not yet certified | — |
| `github` | — | — | not yet certified | — |
| `gmail` | — | — | not yet certified | — |
| `google-calendar` | — | — | not yet certified | — |
| `google-drive` | — | — | not yet certified | — |
| `google-sheets` | — | — | not yet certified | — |
| `hubspot` | — | — | not yet certified | — |
| `instagram-data` | — | — | not yet certified | — |
| `linear` | — | — | not yet certified | — |
| `linkedin-data` | — | — | not yet certified | — |
| `livekit` | — | — | not yet certified | — |
| `microsoft-outlook` | — | — | not yet certified | — |
| `notion` | — | — | not yet certified | — |
| `odoo` | — | — | not yet certified | — |
| `pipecat` | — | — | not yet certified | — |
| `quickbooks` | — | — | not yet certified | — |
| `reddit-data` | — | — | not yet certified | — |
| `serper` | — | — | not yet certified | — |
| `shopify` | — | — | not yet certified | — |
| `slack` | — | — | not yet certified | — |
| `snapchat-data` | — | — | not yet certified | — |
| `stripe` | — | — | not yet certified | — |
| `telegram` | — | — | not yet certified | — |
| `tiktok-data` | — | — | not yet certified | — |
| `twilio` | — | — | not yet certified | — |
| `twitch-data` | — | — | not yet certified | — |
| `voice-agents` | — | — | not yet certified | — |
| `whatsapp-business` | — | — | not yet certified | — |
| `x-data` | — | — | not yet certified | — |
| `youtube-data` | — | — | not yet certified | — |
| `zendesk` | — | — | not yet certified | — |

The frozen catalog 1.0 P0 inventory is listed in full, including `firecrawl` and `serper`, whose executable manifests
are not yet shipped. The additive catalog 1.1 `voice-agents` provider is included as well.
