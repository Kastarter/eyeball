# Provider Catalog

Status: launch-scope baseline  
Catalog version: 1.0  
Snapshot date: 2026-07-16

This is the definitive provider and canonical-tool catalog for eyeball. It fixes the initial toolkit slugs, capability contracts, source path, authentication class, and delivery tier used by the core catalog and mocks repository. It should be changed deliberately: renaming a canonical tool or toolkit slug is an API change.

## How to read this document

- A **canonical tool** is a provider-neutral operation within one capability. At runtime it is namespaced by toolkit, for example `gmail.send_email`, `slack.send_message`, or `instagram-data.get_profile`. Providers may implement only the subset named in their Notes cell; unsupported operations must be absent from that provider's manifest, not emulated with surprising behavior.
- A **provider** is a connectable toolkit with a stable slug. The slug is the code-form value in the Provider column. Similar products are split when scopes or data models differ, such as `microsoft-outlook`, `microsoft-calendar`, and `microsoft-excel`.
- Canonical names are reusable patterns, not a promise that schemas are identical across capabilities. For example, CRM `create_customer` and accounting `create_customer` are separate capability-scoped contracts. Summary tool counts therefore count capability-tool contracts.
- **Auth type** is the primary managed-connection shape: `oauth2`, `api_key`, `basic`, or `none`. `api_key` also covers bearer/PAT tokens, signed credential tuples, service-account keys, and vendor token sets; `basic` covers username/password and HTTP Basic-style credential pairs. Alternate auth modes belong in provider metadata later.
- **Source** is one of `activepieces-bridge`, `native`, or `scrapecreators`. A bridge row means the intended implementation comes from a pinned MIT-licensed Activepieces piece. It is still gated by the bridge compatibility suite; the source label is not a claim that an untested upstream piece already runs in eyeball.
- **Tier** is delivery priority: **P0** is the launch/demo contract, **P1** is the first breadth wave after launch, and **P2** is backlog, enterprise-heavy, regional, or an alternate provider. Tier does not indicate vendor quality.
- A provider may appear in more than one capability matrix. Summary provider and tier counts deduplicate by toolkit slug.

The evidence baseline is the [eyeball product specification](../SPEC.md), the [Activepieces connector catalog](https://www.activepieces.com/pieces/), and the [ScrapeCreators platform catalog](https://scrapecreators.com/). Upstream catalogs change continuously; every shipped provider must pin a source version and pass an execution fixture before its manifest is published.

## Capability taxonomy

| # | Capability | Contract focus |
|---:|---|---|
| 1 | Email | Mailboxes, threads, drafts, search, and delivery |
| 2 | Calendar & Scheduling | Calendars, events, availability, and booking links |
| 3 | Messaging & Chat | Channels, messages, replies, reactions, and members |
| 4 | Voice & Telephony | PSTN/WebRTC calls, rooms, media, speech, and pipelines |
| 5 | SMS | SMS/MMS delivery, status, and verification |
| 6 | CRM | Contacts, companies, deals, activities, and notes |
| 7 | ERP & Accounting | Customers, invoices, bills, ledgers, and payments |
| 8 | Social Media Data | Public profiles, content, comments, discovery, and transcripts |
| 9 | Social Media Publishing | Account-authorized publishing, scheduling, media, and metrics |
| 10 | File Storage & Docs | Files, folders, sharing, document export, and object storage |
| 11 | Spreadsheets & Databases | Rows, ranges, records, tables, and queries |
| 12 | Project Management & Dev Tools | Projects, tasks, issues, code review, builds, and deploys |
| 13 | Payments & Billing | Payments, refunds, invoices, subscriptions, and transactions |
| 14 | E-commerce | Catalog, orders, inventory, fulfillment, and customers |
| 15 | Customer Support | Tickets, conversations, assignment, and replies |
| 16 | Web Search & Scraping | Search, rendered pages, crawls, extraction, and site maps |
| 17 | HR & Recruiting | Employees, candidates, jobs, and leave |
| 18 | Marketing & Ads | Campaigns, audiences, sends, ads, and performance |
| 19 | Sign & Forms | Signature requests, forms, and responses |
| 20 | AI/Media Utilities | Text, image, audio, document, and media transformations |

## 1. Email

### Canonical tools

| Canonical tool | Description |
|---|---|
| `send_email` | Send a new message with recipients, content, and optional attachments. |
| `list_emails` | List messages from a mailbox or folder with pagination and filters. |
| `get_email` | Retrieve one message, headers, body, and attachment metadata. |
| `reply_to_email` | Reply within an existing message or thread. |
| `create_draft` | Create an unsent draft message. |
| `search_emails` | Search mailbox content using provider-supported query filters. |
| `list_threads` | List conversation threads and their latest state. |
| `add_email_label` | Apply a label, category, or folder operation to a message. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `gmail` — Gmail | oauth2 | activepieces-bridge | P0 | Full mailbox/thread launch target; service-account mode may be added as alternate auth. |
| `microsoft-outlook` — Microsoft Outlook / Graph Mail | oauth2 | activepieces-bridge | P0 | Microsoft Graph mail, folders, drafts, replies, and search. |
| `smtp` — Generic SMTP | basic | activepieces-bridge | P1 | Send-only baseline; no mailbox listing, search, or thread operations. |
| `sendgrid` — SendGrid | api_key | activepieces-bridge | P1 | Transactional send and templates; delivery events arrive later through triggers. |
| `resend` — Resend | api_key | activepieces-bridge | P1 | Transactional send and domain-backed delivery; no mailbox reads. |
| `mailgun` — Mailgun | api_key | activepieces-bridge | P1 | Transactional send and stored-event lookup; no general mailbox model. |

## 2. Calendar & Scheduling

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_calendars` | List calendars visible to the connected account. |
| `list_events` | List events in a time range with calendar and attendee filters. |
| `get_event` | Retrieve one event and its attendance state. |
| `create_event` | Create an event with attendees, recurrence, and conferencing data. |
| `update_event` | Update an existing event or recurrence instance. |
| `delete_event` | Delete or cancel an event. |
| `find_available_times` | Compute candidate time slots from free/busy information. |
| `create_scheduling_link` | Create or retrieve a bookable scheduling link. |
| `respond_to_event` | Accept, tentatively accept, or decline an invitation. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `google-calendar` — Google Calendar | oauth2 | activepieces-bridge | P0 | Full event CRUD, attendees, recurrence, and free/busy launch target. |
| `microsoft-calendar` — Microsoft 365 Calendar | oauth2 | activepieces-bridge | P1 | Microsoft Graph calendars, events, responses, and schedules. |
| `calendly` — Calendly | oauth2 | activepieces-bridge | P1 | Event types, scheduling links, invitees, and scheduled-event reads. |
| `cal-com` — Cal.com | api_key | activepieces-bridge | P1 | Booking links, availability, bookings, and cancellations. |
| `savvycal` — SavvyCal | oauth2 | activepieces-bridge | P1 | Scheduling links and event/attendee operations. |
| `zoom` — Zoom | oauth2 | activepieces-bridge | P1 | Meeting creation and management; not a general calendar store. |
| `acuity-scheduling` — Acuity Scheduling | oauth2 | activepieces-bridge | P2 | Appointment types, availability, appointments, and cancellations. |

## 3. Messaging & Chat

### Canonical tools

| Canonical tool | Description |
|---|---|
| `send_message` | Send a message to a channel, room, group, or direct recipient. |
| `list_channels` | List channels, rooms, groups, or chats visible to the connection. |
| `list_messages` | List recent messages in a conversation with pagination. |
| `get_message` | Retrieve one message and its metadata. |
| `reply_to_message` | Reply in a thread or to a specific message. |
| `add_reaction` | Add an emoji or supported reaction to a message. |
| `create_channel` | Create a channel, room, or group where the provider permits it. |
| `list_members` | List members of a workspace, channel, or chat. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `slack` — Slack | oauth2 | activepieces-bridge | P0 | Channels, DMs, threads, reactions, files, and member lookup. |
| `discord` — Discord | api_key | activepieces-bridge | P0 | Bot-token connection for guild channels, messages, threads, and reactions. |
| `telegram` — Telegram Bot | api_key | activepieces-bridge | P0 | Bot API chats, messages, media, edits, and replies. |
| `whatsapp-business` — WhatsApp Business Cloud | api_key | activepieces-bridge | P0 | Meta Cloud API templates, session messages, and media; distinct from Twilio WhatsApp. |
| `microsoft-teams` — Microsoft Teams | oauth2 | activepieces-bridge | P1 | Teams, channels, chats, messages, and member operations through Graph. |
| `google-chat` — Google Chat | oauth2 | activepieces-bridge | P1 | Spaces, messages, threads, and memberships. |
| `mattermost` — Mattermost | api_key | activepieces-bridge | P1 | Server URL plus token; channels, posts, threads, and users. |
| `rocket-chat` — Rocket.Chat | api_key | activepieces-bridge | P2 | Self-hosted URL plus personal/bot token; rooms and messages. |
| `line` — LINE Messaging API | api_key | activepieces-bridge | P2 | Channel access token; push/reply messages and audience operations. |

## 4. Voice & Telephony

Voice is a first-class execution surface, not a thin CRUD bridge. Starting a call or voice pipeline is asynchronous: the request returns an execution ID, status is pollable, and terminal events can be delivered by webhook. Other voice operations follow their resolved RFC 001 annotations. RFC 002 defines dynamic voice-agent creation, prompt/model/provider composition, phone-number binding, inbound routing, safety controls, and recording policy through the additive catalog 1.1 `voice-agents` toolkit; it does not change this catalog 1.0 provider surface.

### Canonical tools

| Canonical tool | Description |
|---|---|
| `start_call` | Start an outbound PSTN, SIP, or provider-hosted call and return an execution ID. |
| `get_call` | Retrieve call state, participants, timing, and provider identifiers. |
| `list_calls` | List calls using status, participant, and time filters. |
| `end_call` | End an active call. |
| `transfer_call` | Transfer or bridge an active call to another destination. |
| `send_dtmf` | Send DTMF digits to an active call leg. |
| `create_room` | Create a realtime audio/video room with access metadata. |
| `join_room` | Create participant credentials or join instructions for a room. |
| `synthesize_speech` | Convert text to speech using a selected voice and audio format. |
| `transcribe_audio` | Convert audio or a live audio source into text. |
| `start_voice_pipeline` | Start a composed transport, speech, model, and tool pipeline. |
| `get_voice_pipeline` | Retrieve pipeline state, events, and terminal outcome. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `twilio` — Twilio | basic | native | P0 | PSTN/SIP calls, call control, recordings, SMS, and WhatsApp using Account SID/Auth Token. |
| `livekit` — LiveKit | api_key | native | P0 | Realtime rooms, WebRTC participants, tracks, SIP, and agent-session transport. |
| `pipecat` — Pipecat | none | native | P0 | Open-source voice-agent pipeline runtime; provider credentials come from composed toolkits. |
| `elevenlabs` — ElevenLabs | api_key | native | P0 | Low-latency TTS, configured voices, and streaming audio. |
| `deepgram` — Deepgram | api_key | native | P0 | Streaming and prerecorded STT with transcript events. |
| `telnyx` — Telnyx | api_key | native | P1 | PSTN/SIP calls, media streaming, SMS, and number operations. |
| `retell-ai` — Retell AI | api_key | native | P1 | Hosted voice-agent calls and lifecycle; a future adapter must compile RFC 002 revisions without changing their portable contract. |
| `vapi` — Vapi | api_key | native | P1 | Hosted voice-call orchestration; a future adapter must compile RFC 002 revisions without changing their portable contract. |
| `vonage` — Vonage | api_key | native | P2 | Voice API and SMS alternate; JWT signing data is stored in the api_key credential class. |
| `plivo` — Plivo | basic | native | P2 | PSTN/SIP calls and SMS alternate using Auth ID/Auth Token. |

## 5. SMS

### Canonical tools

| Canonical tool | Description |
|---|---|
| `send_sms` | Send a plain-text message to one or more phone numbers. |
| `get_sms` | Retrieve one outbound or inbound message record. |
| `list_sms` | List message records using recipient, sender, status, and time filters. |
| `send_mms` | Send a message with supported media attachments. |
| `get_delivery_status` | Retrieve normalized carrier and provider delivery state. |
| `send_verification_code` | Start a provider-managed one-time-code verification. |
| `check_verification_code` | Verify a submitted one-time code. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `twilio` — Twilio | basic | native | P0 | SMS/MMS and Verify; shares the P0 Twilio connection with Voice & Telephony. |
| `telnyx` — Telnyx | api_key | native | P1 | SMS/MMS and delivery status; shares the P1 voice provider. |
| `messagebird` — MessageBird / Bird | api_key | activepieces-bridge | P1 | SMS and messaging API; normalize current Bird product naming behind stable slug. |
| `clicksend-sms` — ClickSend SMS | api_key | activepieces-bridge | P1 | SMS/MMS send and delivery history. |
| `vonage` — Vonage | api_key | native | P2 | SMS and Verify alternate; shares the P2 voice provider. |
| `plivo` — Plivo | basic | native | P2 | SMS/MMS alternate; shares the P2 voice provider. |
| `textmagic` — TextMagic | basic | activepieces-bridge | P2 | Username/API-key pair, messaging, contacts, and status. |
| `aws-sns` — Amazon SNS | api_key | activepieces-bridge | P2 | AWS access credentials for SMS publish; no conversational inbox abstraction. |

## 6. CRM

### Canonical tools

| Canonical tool | Description |
|---|---|
| `create_contact` | Create a person/contact record. |
| `get_contact` | Retrieve one contact by provider ID. |
| `search_contacts` | Search contacts by identity, property, or provider query. |
| `update_contact` | Update fields on an existing contact. |
| `create_company` | Create an account, organization, or company record. |
| `update_company` | Update an account, organization, or company record. |
| `create_deal` | Create an opportunity or deal in a pipeline. |
| `update_deal` | Update deal fields, stage, amount, or owner. |
| `list_activities` | List calls, meetings, tasks, or timeline activities for a record. |
| `add_note` | Add a note to a contact, company, or deal. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `hubspot` — HubSpot | oauth2 | activepieces-bridge | P0 | Launch CRM for contacts, companies, deals, owners, associations, and notes. |
| `salesforce` — Salesforce | oauth2 | activepieces-bridge | P1 | Standard/custom objects and SOQL-backed search; canonical CRM mappings cover core objects. |
| `pipedrive` — Pipedrive | oauth2 | activepieces-bridge | P1 | Persons, organizations, deals, activities, notes, and pipelines. |
| `zoho-crm` — Zoho CRM | oauth2 | activepieces-bridge | P1 | Leads, contacts, accounts, deals, activities, and module records. |
| `attio` — Attio | oauth2 | activepieces-bridge | P1 | Objects, records, lists, attributes, and notes. |
| `close` — Close | api_key | activepieces-bridge | P1 | Leads, contacts, opportunities, activities, and notes. |
| `dynamics-365` — Microsoft Dynamics 365 Sales | oauth2 | activepieces-bridge | P2 | Dataverse-backed accounts, contacts, opportunities, and activities. |
| `freshsales` — Freshsales | api_key | activepieces-bridge | P2 | Contacts, accounts, deals, tasks, and notes. |
| `copper` — Copper | oauth2 | activepieces-bridge | P2 | People, companies, opportunities, activities, and tasks. |
| `streak` — Streak | oauth2 | activepieces-bridge | P2 | Gmail-native pipelines, boxes, contacts, and tasks. |

## 7. ERP & Accounting

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_customers` | List customer or partner records with pagination and filters. |
| `create_customer` | Create a customer or business partner. |
| `list_invoices` | List sales invoices by state, customer, or date. |
| `get_invoice` | Retrieve an invoice, line items, totals, and status. |
| `create_invoice` | Create a sales invoice with line items, tax, and terms. |
| `send_invoice` | Issue or email an invoice using the provider workflow. |
| `record_payment` | Record or apply a payment to an invoice or account. |
| `list_bills` | List vendor bills or accounts-payable documents. |
| `create_bill` | Create a vendor bill with line items and due terms. |
| `list_accounts` | List chart-of-account or ledger accounts. |
| `create_journal_entry` | Create a balanced general-ledger journal entry. |
| `search_erp_records` | Search a supported ERP model or accounting object. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `odoo` — Odoo | basic | activepieces-bridge | P0 | Contacts plus generic model search/create/update through XML-RPC; URL, database, username, and API key. |
| `quickbooks` — QuickBooks Online | oauth2 | activepieces-bridge | P0 | Customers, invoices, bills, payments, accounts, and journal entries. |
| `xero` — Xero | oauth2 | activepieces-bridge | P1 | Contacts, invoices, bills, payments, accounts, and tenant selection. |
| `zoho-books` — Zoho Books | oauth2 | activepieces-bridge | P1 | Organization-scoped contacts, invoices, bills, payments, and journals. |
| `sage-business-cloud` — Sage Business Cloud Accounting | oauth2 | activepieces-bridge | P1 | Contacts, sales invoices, purchase invoices, payments, and ledgers. |
| `freshbooks` — FreshBooks | oauth2 | activepieces-bridge | P1 | Clients, invoices, expenses, payments, and time entries. |
| `netsuite` — Oracle NetSuite | api_key | activepieces-bridge | P2 | SuiteTalk records; token-based OAuth 1 credential tuple is classified as api_key. |
| `sap-business-one` — SAP Business One | basic | native | P2 | Service Layer business partners, documents, inventory, and journals; enterprise test environment required. |
| `oracle-fusion-cloud-erp` — Oracle Fusion Cloud ERP | basic | activepieces-bridge | P2 | Receivables, payables, ledgers, and suppliers; enterprise instance variability. |
| `dynamics-365-business-central` — Microsoft Dynamics 365 Business Central | oauth2 | activepieces-bridge | P2 | Companies, customers, sales invoices, vendors, purchase invoices, and journals. |
| `wave-accounting` — Wave | oauth2 | activepieces-bridge | P2 | Businesses, customers, invoices, products, and money transactions. |

## 8. Social Media Data

These are public-data adapters backed by one managed ScrapeCreators connection. They are deliberately separate toolkit slugs so customers can enable platforms independently and agents only see relevant schemas. ScrapeCreators is an unofficial data source; the provider notes below state the grounded endpoint surface rather than implying uniform parity. Do not expose a canonical tool for a provider unless its ScrapeCreators platform documentation supports that operation.

### Canonical tools

| Canonical tool | Description |
|---|---|
| `get_profile` | Retrieve a public creator or user profile and visible metrics. |
| `get_posts` | List public posts or media for a profile or community. |
| `get_post` | Retrieve one post, video, clip, short, or media item. |
| `get_comments` | List public comments and supported replies for a content item. |
| `search_posts` | Search public content using a platform-supported query. |
| `search_creators` | Search or discover creators where the platform adapter supports it. |
| `get_transcript` | Retrieve or derive the transcript for a supported public video/audio post. |
| `get_channel` | Retrieve a channel, company, community, or subreddit entity. |
| `get_channel_videos` | List videos, shorts, streams, or clips from a channel. |
| `get_live_content` | Retrieve current or scheduled live-content metadata. |
| `get_audience_metrics` | Retrieve public or explicitly supported audience/engagement metrics. |
| `get_trending_content` | Retrieve a documented trending feed, hashtag, reel, or short surface. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `instagram-data` — Instagram via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: profile, posts/reels, post detail, comments, transcript, hashtag/profile search, and trending reels; comments are documented as less reliable. |
| `tiktok-data` — TikTok via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: profile, profile videos, video detail/comments, transcript, user search, popular creators, audience countries, live state, hashtags, and trending feed. |
| `youtube-data` — YouTube via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: channel, videos/shorts/lives/community posts, video detail/comments, transcript, search, playlists, and trending shorts. |
| `x-data` — Twitter/X via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: profile, user tweets, tweet detail, video-tweet transcript, community, and community tweets; no general comments or search promise. |
| `linkedin-data` — LinkedIn via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: public person profile/recent posts, company page/posts, public post search, post detail, and available video transcript. |
| `reddit-data` — Reddit via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: subreddit details/posts/search, sitewide post search, post comments, and Reddit-video transcript. |
| `twitch-data` — Twitch via ScrapeCreators | api_key | scrapecreators | P0 | Confirmed: profile, user videos, user schedule, and clip detail; no comment, creator-search, or transcript promise. |
| `snapchat-data` — Snapchat via ScrapeCreators | api_key | scrapecreators | P0 | Only public user profile is confirmed in the documented endpoint list; do not promise posts, stories, comments, search, or transcript until documented. |

## 9. Social Media Publishing

### Canonical tools

| Canonical tool | Description |
|---|---|
| `create_post` | Publish a text or mixed-media post immediately. |
| `schedule_post` | Schedule a post for future publication. |
| `get_published_post` | Retrieve one published or scheduled post and its state. |
| `delete_post` | Delete a post where the provider API permits it. |
| `upload_media` | Upload media for later attachment or publishing. |
| `publish_video` | Publish a video, reel, short, or equivalent media item. |
| `publish_story` | Publish an ephemeral story where supported. |
| `get_post_metrics` | Retrieve provider-authorized reach and engagement metrics. |
| `list_social_accounts` | List pages, channels, organizations, or profiles available to publish. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `facebook-pages` — Facebook Pages | oauth2 | activepieces-bridge | P1 | Page selection, feed posts, photos/videos, and page insights. |
| `instagram-for-business` — Instagram for Business | oauth2 | activepieces-bridge | P1 | Professional-account photos, carousels, reels, stories, and insights. |
| `linkedin-publishing` — LinkedIn Publishing | oauth2 | activepieces-bridge | P1 | Member/organization posts, articles/media, deletion, and authorized metrics. |
| `x-publishing` — Twitter/X Publishing | oauth2 | activepieces-bridge | P1 | Posts, replies, media, deletion, and account-authorized lookup subject to X API tier. |
| `youtube-publishing` — YouTube Publishing | oauth2 | activepieces-bridge | P1 | Video upload, metadata, playlists, and channel-authorized analytics. |
| `pinterest` — Pinterest | oauth2 | activepieces-bridge | P1 | Boards, pins, media, and pin analytics. |
| `buffer` — Buffer | oauth2 | activepieces-bridge | P1 | Cross-network profiles, drafts, queueing, and scheduling. |
| `typefully` — Typefully | api_key | activepieces-bridge | P1 | Drafting/scheduling for supported networks and publication status. |
| `tiktok-publishing` — TikTok Content Posting | oauth2 | native | P2 | Direct-post/upload APIs with app review; distinct from public-data scraping. |
| `hootsuite` — Hootsuite | oauth2 | activepieces-bridge | P2 | Cross-network scheduling and status where the upstream piece exposes it. |
| `mastodon` — Mastodon | api_key | activepieces-bridge | P2 | Instance URL plus access token; statuses, media, replies, and deletion. |

## 10. File Storage & Docs

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_files` | List files and folders within a location. |
| `get_file` | Retrieve file metadata and a content/download reference. |
| `search_files` | Search file names, metadata, or provider-indexed content. |
| `upload_file` | Upload a new file or object. |
| `download_file` | Download file content through the executor's binary transport. |
| `move_file` | Move or rename a file or object. |
| `delete_file` | Delete or trash a file or object. |
| `create_folder` | Create a folder, prefix, or directory-like container. |
| `share_file` | Create or update access permissions or a share link. |
| `export_document` | Export a native document to a requested supported format. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `google-drive` — Google Drive | oauth2 | activepieces-bridge | P0 | Launch file provider for search, upload/download, folders, permissions, and Google-native export. |
| `dropbox` — Dropbox | oauth2 | activepieces-bridge | P1 | Files, folders, search, moves, shared links, and revisions. |
| `onedrive` — Microsoft OneDrive | oauth2 | activepieces-bridge | P1 | Microsoft Graph drives, items, upload/download, folders, and sharing. |
| `box` — Box | oauth2 | activepieces-bridge | P1 | Files, folders, search, collaborations, and shared links. |
| `google-docs` — Google Docs | oauth2 | activepieces-bridge | P1 | Create/read/edit document content and export through Drive. |
| `sharepoint` — Microsoft SharePoint | oauth2 | activepieces-bridge | P1 | Sites, document libraries, drives, list-backed files, and permissions. |
| `amazon-s3` — Amazon S3 | api_key | activepieces-bridge | P1 | Buckets, objects, prefixes, copy/move, signed downloads, and metadata. |
| `cloudinary` — Cloudinary | api_key | activepieces-bridge | P1 | Media upload, search, transformations, delivery URLs, and deletion. |
| `sftp` — SFTP | basic | activepieces-bridge | P2 | Host/user/password or SSH-key connection; files and directories. |
| `egnyte` — Egnyte | oauth2 | activepieces-bridge | P2 | Enterprise files, folders, links, permissions, and search. |

## 11. Spreadsheets & Databases

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_rows` | List rows or records from a sheet, table, or view with pagination and filters. |
| `get_row` | Retrieve one row or record by provider identifier. |
| `create_row` | Create a row or record with field values. |
| `update_row` | Update fields or cells on an existing row or record. |
| `delete_row` | Delete one row or record. |
| `search_rows` | Search or filter rows using provider-supported expressions. |
| `append_row` | Append a row to the end of a sheet or table. |
| `get_range` | Read a rectangular spreadsheet range and its values. |
| `update_range` | Write values to a rectangular spreadsheet range. |
| `list_tables` | List worksheets, tables, collections, or database views. |
| `run_query` | Execute a provider-supported SQL or query-language statement and return tabular results. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `google-sheets` — Google Sheets | oauth2 | activepieces-bridge | P0 | Launch spreadsheet target for worksheets, row search/append, and range reads/writes. |
| `airtable` — Airtable | oauth2 | activepieces-bridge | P0 | Bases, tables, views, record CRUD, and formula-backed filtering; no spreadsheet ranges. |
| `notion` — Notion | oauth2 | activepieces-bridge | P0 | Databases, data sources, pages, property updates, and filtered queries; also fits File Storage & Docs. |
| `microsoft-excel` — Microsoft Excel | oauth2 | activepieces-bridge | P1 | Microsoft Graph workbooks, worksheets, tables, ranges, and row writes. |
| `postgres` — PostgreSQL | basic | activepieces-bridge | P1 | Host/database/user credentials for table discovery, parameterized SQL, and row operations. |
| `mysql` — MySQL | basic | activepieces-bridge | P1 | Host/database/user credentials for table discovery, parameterized SQL, and row operations. |
| `supabase` — Supabase | api_key | activepieces-bridge | P1 | PostgREST table CRUD and filters plus RPC calls exposed by the connected project. |
| `mongodb` — MongoDB | basic | activepieces-bridge | P2 | Databases, collections, document CRUD, and document filters; maps documents to records, not ranges. |
| `smartsheet` — Smartsheet | oauth2 | activepieces-bridge | P2 | Sheets, rows, columns, cells, attachments, and row placement. |
| `baserow` — Baserow | api_key | activepieces-bridge | P2 | Databases, tables, fields, row CRUD, and filtering for cloud or self-hosted instances. |
| `nocodb` — NocoDB | api_key | activepieces-bridge | P2 | Bases, tables, views, record CRUD, filtering, and pagination. |

## 12. Project Management & Dev Tools

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_projects` | List projects, repositories, boards, or workspaces visible to the connection. |
| `create_issue` | Create an issue, work item, or defect with title, body, and ownership metadata. |
| `get_issue` | Retrieve one issue or work item and its current state. |
| `list_issues` | List issues or work items using project, assignee, state, and label filters. |
| `update_issue` | Update issue fields, state, assignment, labels, or priority. |
| `add_comment` | Add a comment or discussion update to an issue or task. |
| `create_task` | Create a task, card, or to-do in a project container. |
| `get_task` | Retrieve one task, card, or to-do and its metadata. |
| `update_task` | Update task fields, completion state, dates, or assignment. |
| `get_pull_request` | Retrieve a pull or merge request, review state, and change metadata. |
| `create_pull_request_comment` | Add a general or provider-supported review comment to a pull or merge request. |
| `list_commits` | List repository commits using branch, author, or time filters. |
| `get_build` | Retrieve a CI build or pipeline run and its jobs, status, and result. |
| `get_deployment` | Retrieve a deployment or release and its environment status. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `github` — GitHub | oauth2 | activepieces-bridge | P0 | Repositories, issues, comments, pull requests, commits, Actions runs, and deployments. |
| `linear` — Linear | oauth2 | activepieces-bridge | P0 | Teams, projects, issues, comments, labels, cycles, states, and assignments. |
| `jira` — Jira Cloud | oauth2 | activepieces-bridge | P1 | Projects, issues, comments, fields, transitions, labels, and users. |
| `asana` — Asana | oauth2 | activepieces-bridge | P1 | Workspaces, projects, tasks, subtasks, comments, dates, and assignments. |
| `trello` — Trello | api_key | activepieces-bridge | P1 | Boards, lists, cards, checklists, comments, labels, and members. |
| `clickup` — ClickUp | oauth2 | activepieces-bridge | P1 | Workspaces, spaces, folders, lists, tasks, comments, and assignees. |
| `monday` — monday.com | oauth2 | activepieces-bridge | P1 | Workspaces, boards, groups, items, subitems, columns, and updates. |
| `gitlab` — GitLab | oauth2 | activepieces-bridge | P1 | Projects, issues, merge requests, notes, commits, pipelines, and deployments. |
| `todoist` — Todoist | oauth2 | activepieces-bridge | P2 | Projects, sections, tasks, comments, labels, and completion state. |
| `basecamp` — Basecamp | oauth2 | activepieces-bridge | P2 | Projects, to-do sets, to-dos, message boards, comments, and schedules. |
| `azure-devops` — Azure DevOps | api_key | activepieces-bridge | P2 | Projects, work items, repositories, pull requests, commits, builds, and releases through a PAT. |

## 13. Payments & Billing

### Canonical tools

| Canonical tool | Description |
|---|---|
| `create_payment_link` | Create a hosted link or checkout for collecting a payment. |
| `get_payment` | Retrieve one payment, charge, order, or transaction and its status. |
| `list_payments` | List payments or transactions using customer, status, and time filters. |
| `create_refund` | Refund all or part of a captured payment. |
| `get_customer` | Retrieve one billing customer and its payment metadata. |
| `create_customer` | Create a billing customer. |
| `list_subscriptions` | List subscriptions using customer, product, or status filters. |
| `cancel_subscription` | Cancel a subscription immediately or at the end of its billing period. |
| `create_invoice` | Create a billing invoice with line items and collection settings. |
| `get_invoice` | Retrieve one billing invoice, totals, due state, and hosted references. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `stripe` — Stripe | api_key | activepieces-bridge | P0 | Payment Links, Payment Intents, charges, refunds, customers, subscriptions, and invoices. |
| `paypal` — PayPal | oauth2 | activepieces-bridge | P1 | Orders, captures, refunds, customers, invoices, and subscription plans. |
| `square` — Square | oauth2 | activepieces-bridge | P1 | Payments, refunds, customers, invoices, catalog references, and subscriptions. |
| `paddle` — Paddle | api_key | activepieces-bridge | P2 | Customers, subscriptions, transactions, adjustments, invoices, and checkout links. |
| `lemon-squeezy` — Lemon Squeezy | api_key | activepieces-bridge | P2 | Customers, orders, subscriptions, invoices, products, and checkout URLs. |
| `razorpay` — Razorpay | basic | activepieces-bridge | P2 | Payment links, payments, refunds, customers, subscriptions, and invoices using key ID/secret. |

## 14. E-commerce

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_products` | List products or catalog items using collection, status, and inventory filters. |
| `get_product` | Retrieve one product, variants, pricing, and inventory metadata. |
| `create_product` | Create a product and its initial variants or options. |
| `update_product` | Update product content, variants, pricing, or publication state. |
| `update_inventory` | Set or adjust inventory for a variant at a location. |
| `list_orders` | List orders using customer, fulfillment, payment, and time filters. |
| `get_order` | Retrieve one order, line items, customer, totals, and fulfillment state. |
| `update_order` | Update provider-supported order fields, status, or metadata. |
| `create_fulfillment` | Create a fulfillment or shipment with items and tracking data. |
| `list_customers` | List store customers using identity and time filters. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `shopify` — Shopify | oauth2 | activepieces-bridge | P0 | Products, variants, inventory, customers, orders, fulfillments, and tracking through the Admin API. |
| `woocommerce` — WooCommerce | basic | activepieces-bridge | P1 | Products, variations, stock, customers, orders, notes, and refunds using consumer credentials. |
| `bigcommerce` — BigCommerce | api_key | activepieces-bridge | P2 | Catalog products, variants, inventory, customers, orders, and shipments. |
| `squarespace` — Squarespace Commerce | api_key | activepieces-bridge | P2 | Products, variants, inventory, orders, transactions, and fulfillment updates. |
| `etsy` — Etsy | oauth2 | activepieces-bridge | P2 | Shop listings, listing inventory, receipts, transactions, and shipment tracking. |
| `magento` — Adobe Commerce / Magento | api_key | activepieces-bridge | P2 | Products, stock, customers, orders, invoices, shipments, and credit memos. |

## 15. Customer Support

### Canonical tools

| Canonical tool | Description |
|---|---|
| `create_ticket` | Create a support ticket with requester, subject, content, and priority. |
| `get_ticket` | Retrieve one ticket, requester, status, assignment, and custom fields. |
| `list_tickets` | List tickets using requester, assignee, status, priority, and time filters. |
| `update_ticket` | Update ticket status, priority, tags, fields, or assignment. |
| `add_ticket_reply` | Add a public reply or internal note to a ticket. |
| `assign_ticket` | Assign a ticket to an agent, team, or group. |
| `list_conversations` | List inbox conversations using state, assignee, and time filters. |
| `get_conversation` | Retrieve one conversation and its message history. |
| `send_conversation_reply` | Reply to an inbox conversation as the connected workspace. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `zendesk` — Zendesk | oauth2 | activepieces-bridge | P0 | Tickets, users, organizations, comments, groups, assignment, tags, and custom fields. |
| `intercom` — Intercom | oauth2 | activepieces-bridge | P1 | Contacts, conversations, messages, notes, assignment, tags, and closure. |
| `freshdesk` — Freshdesk | api_key | activepieces-bridge | P1 | Tickets, contacts, agents, groups, replies, notes, status, and assignment. |
| `front` — Front | oauth2 | activepieces-bridge | P1 | Inboxes, conversations, messages, comments, teammates, tags, and assignment. |
| `help-scout` — Help Scout | oauth2 | activepieces-bridge | P2 | Mailboxes, conversations, threads, customers, users, tags, and assignment. |
| `gorgias` — Gorgias | basic | activepieces-bridge | P2 | Tickets, messages, customers, users, tags, and assignment using domain/user/API-key credentials. |

## 16. Web Search & Scraping

### Canonical tools

| Canonical tool | Description |
|---|---|
| `web_search` | Search the public web and return ranked results with titles, URLs, and snippets. |
| `get_page_content` | Fetch one page and return normalized text, Markdown, or supported HTML. |
| `crawl_site` | Crawl a bounded site or URL set and return discovered page content. |
| `extract_structured_data` | Extract schema-constrained structured data from one or more pages. |
| `get_sitemap` | Discover or retrieve a site's sitemap URLs. |
| `take_screenshot` | Render a page and return a screenshot at requested viewport settings. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `firecrawl` — Firecrawl | api_key | activepieces-bridge | P0 | Page scrape, crawl, map/sitemap discovery, search, and schema-guided extraction. |
| `serper` — Serper | api_key | activepieces-bridge | P0 | Google-backed web, news, image, places, and shopping search results; no general crawler. |
| `serpapi` — SerpApi | api_key | activepieces-bridge | P1 | Multi-engine search result pages and vertical results; no general crawler. |
| `tavily` — Tavily | api_key | activepieces-bridge | P1 | Agent-oriented web search, result content extraction, and bounded site filtering. |
| `browserless` — Browserless | api_key | activepieces-bridge | P2 | Browser-rendered page content, scripted extraction, PDFs, and screenshots. |
| `jina-reader` — Jina AI Reader | none | native | P2 | Public URL-to-Markdown page reads through the Reader endpoint; no authenticated-site or crawl promise. |

## 17. HR & Recruiting

### Canonical tools

| Canonical tool | Description |
|---|---|
| `list_employees` | List employee records using team, location, status, and employment filters. |
| `get_employee` | Retrieve one employee's profile, role, organization, and employment metadata. |
| `create_candidate` | Create a candidate or application for a recruiting job. |
| `get_candidate` | Retrieve one candidate, applications, stage, and recruiting activity. |
| `list_candidates` | List candidates using job, stage, owner, and time filters. |
| `update_candidate_stage` | Move a candidate or application to another recruiting stage. |
| `list_jobs` | List recruiting jobs or openings and their publication state. |
| `create_time_off_request` | Create a leave or time-off request for an employee. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `bamboohr` — BambooHR | api_key | activepieces-bridge | P1 | Employee directory, employee fields, reports, time-off balances, and requests; no recruiting contract. |
| `greenhouse` — Greenhouse | api_key | activepieces-bridge | P1 | Jobs, candidates, applications, stages, activities, and recruiter ownership through Harvest APIs. |
| `lever` — Lever | oauth2 | activepieces-bridge | P2 | Postings, candidates, opportunities, applications, stages, notes, and owners. |
| `personio` — Personio | oauth2 | activepieces-bridge | P2 | Employees, attributes, absences, recruiting jobs, candidates, and application phases. |
| `workable` — Workable | api_key | activepieces-bridge | P2 | Jobs, candidates, profiles, pipeline stages, activities, and recruiting members. |
| `gusto` — Gusto | oauth2 | activepieces-bridge | P2 | Companies, employees, contractors, onboarding fields, payroll metadata, and supported time-off policies. |

## 18. Marketing & Ads

### Canonical tools

| Canonical tool | Description |
|---|---|
| `add_contact_to_list` | Add or update a contact in a mailing list, audience, or segment. |
| `create_campaign` | Create an email, newsletter, or advertising campaign. |
| `send_campaign` | Send or publish a prepared campaign. |
| `get_campaign` | Retrieve one campaign, configuration, and delivery state. |
| `get_campaign_stats` | Retrieve normalized delivery, engagement, conversion, or advertising metrics. |
| `create_audience` | Create a list, segment, or advertising audience. |
| `list_forms` | List lead-capture or subscription forms and their status. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `mailchimp` — Mailchimp | oauth2 | activepieces-bridge | P1 | Audiences, members, tags, segments, campaigns, sends, reports, and signup forms. |
| `klaviyo` — Klaviyo | api_key | activepieces-bridge | P1 | Profiles, lists, segments, events, campaigns, flows, and engagement metrics. |
| `brevo` — Brevo | api_key | activepieces-bridge | P1 | Contacts, lists, attributes, email campaigns, sends, reports, and forms. |
| `activecampaign` — ActiveCampaign | api_key | activepieces-bridge | P2 | Contacts, lists, tags, campaigns, automations, forms, and campaign reports. |
| `google-ads` — Google Ads | oauth2 | activepieces-bridge | P2 | Campaigns, ad groups, customer lists, conversions, budgets, and performance reports; no email sends. |
| `meta-ads` — Meta Ads | oauth2 | activepieces-bridge | P2 | Campaigns, ad sets, ads, custom audiences, creatives, and insights; no email sends. |
| `beehiiv` — beehiiv | api_key | activepieces-bridge | P2 | Publications, subscribers, segments, newsletter posts, sends, and publication analytics. |

## 19. Sign & Forms

### Canonical tools

| Canonical tool | Description |
|---|---|
| `create_signature_request` | Create and send a document signature request to one or more signers. |
| `get_signature_request` | Retrieve one signature request, recipients, and completion state. |
| `list_signature_requests` | List signature requests using status, sender, recipient, and time filters. |
| `download_signed_document` | Download the completed signed document or evidence bundle. |
| `list_forms` | List forms visible to the connected account. |
| `list_form_responses` | List submitted responses for a form with pagination and time filters. |
| `get_form_response` | Retrieve one response and its normalized answers. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `docusign` — DocuSign | oauth2 | activepieces-bridge | P1 | Templates, envelopes, recipients, send/status operations, completed documents, and evidence. |
| `dropbox-sign` — Dropbox Sign | api_key | activepieces-bridge | P2 | Signature requests, templates, signers, status, reminders, and completed-file downloads. |
| `pandadoc` — PandaDoc | api_key | activepieces-bridge | P1 | Documents from templates, recipients, send/status operations, and completed PDFs. |
| `typeform` — Typeform | oauth2 | activepieces-bridge | P1 | Workspaces, forms, questions, responses, and response pagination; no signatures. |
| `google-forms` — Google Forms | oauth2 | activepieces-bridge | P1 | Forms, question schemas, responses, and linked Google Sheet references; no signatures. |
| `jotform` — Jotform | api_key | activepieces-bridge | P2 | Forms, questions, submissions, files, and response filtering; no signatures. |
| `tally` — Tally | api_key | activepieces-bridge | P2 | Forms, fields, submissions, and response payloads; no signatures. |

## 20. AI/Media Utilities

### Canonical tools

| Canonical tool | Description |
|---|---|
| `generate_image` | Generate an image from a text prompt and optional supported image inputs. |
| `describe_image` | Analyze an image and return a textual description or requested visual fields. |
| `remove_image_background` | Remove an image background and return a transparent or replacement-background asset. |
| `extract_text_from_document` | Extract machine-readable text from a scanned image or document using OCR. |
| `convert_document` | Convert a supported document between file formats. |
| `translate_text` | Translate text between supported languages. |
| `transcribe_audio` | Convert prerecorded audio or video into text with timing metadata. |
| `summarize_url` | Summarize content at a supported public URL. |

### Providers

| Provider | Auth type | Source | Tier | Notes |
|---|---|---|---|---|
| `openai-images` — OpenAI Images | api_key | activepieces-bridge | P1 | Image generation and image-input description; this image-scoped toolkit does not expose general chat operations. |
| `remove-bg` — remove.bg | api_key | activepieces-bridge | P2 | Automated background removal with transparent output and supported replacement backgrounds. |
| `pdf-co` — PDF.co | api_key | activepieces-bridge | P1 | PDF/document conversion, OCR, text extraction, merge/split, and output-file URLs. |
| `deepl` — DeepL | api_key | activepieces-bridge | P1 | Text translation, language detection, formality controls, and supported document translation. |
| `assemblyai` — AssemblyAI | api_key | activepieces-bridge | P1 | Prerecorded audio/video transcription, timestamps, speakers, chapters, and summarization of supported media URLs. |

## Summary

| Metric | Count |
|---|---:|
| Capabilities | 20 |
| Canonical capability-scoped tools | 187 |
| Unique providers | 157 |
| P0 providers | 34 |
| P1 providers | 72 |
| P2 providers | 51 |

Provider and tier counts deduplicate toolkit slugs across capability matrices. Canonical tool counts remain capability-scoped even when the same operation name appears in more than one capability.

## P0 launch set

- `gmail`
- `microsoft-outlook`
- `google-calendar`
- `slack`
- `discord`
- `telegram`
- `whatsapp-business`
- `twilio`
- `livekit`
- `pipecat`
- `elevenlabs`
- `deepgram`
- `hubspot`
- `odoo`
- `quickbooks`
- `instagram-data`
- `tiktok-data`
- `youtube-data`
- `x-data`
- `linkedin-data`
- `reddit-data`
- `twitch-data`
- `snapchat-data`
- `google-drive`
- `google-sheets`
- `airtable`
- `notion`
- `github`
- `linear`
- `stripe`
- `shopify`
- `zendesk`
- `firecrawl`
- `serper`
