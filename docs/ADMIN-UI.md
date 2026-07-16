# eyeball Admin UI — Design Brief

**Status:** Product and visual direction for the hosted control plane  
**Audience:** Product design, frontend engineering, and founders  
**Product posture:** A developer-facing tool platform, not a no-code workflow builder

The admin panel makes a large integration surface feel inspectable, fast, and alive: developers see what agents can do, whose credentials they use, and exactly what happened on every invocation. It should feel premium before it feels busy.

## 1. Design principles and visual language

### 1.1 Product principles

1. **Show the system, not decoration.** Schemas, execution states, connection health, and live events are the visual material.
2. **Precision over dashboard theater.** Prefer exact values, timestamps, IDs, and status language over ambiguous scores.
3. **Progressive density.** First glance answers “is it working?”; the next click exposes I/O, schema, credential scope, and events.
4. **Developer-native, never developer-hostile.** JSON is first-class, but readable labels, plain errors, and copy actions keep it usable.
5. **One project, one operational context.** The active project controls every count, connection, key, toolkit, and execution shown.
6. **Live when it matters.** Active executions and sessions visibly advance; settled records become calm, compact, and stable.

### 1.2 Signature direction

The default theme is a near-black canvas with one brand accent: **Iris Violet `#7C5CFF`**. Violet marks selection, focus, active navigation, primary actions, and live eyeball-owned signals—not gradients or decoration.

Success green, warning amber, and error red exist only for semantic state. Charts begin neutral and introduce violet only for the selected or primary series.

The quality bar combines three archetypes without imitating their surfaces:

- Linear's precision: tight alignment, fast keyboard paths, disciplined state changes.
- Vercel's restraint: monochrome structure, confident whitespace, code-aware typography.
- Stripe's data density: layered inspection, useful tables, and legible technical detail.

### 1.3 Canvas, composition, and density

- Layer near-black canvas, lifted panels, then raised interactive surfaces; avoid identical gray cards.
- Keep a compact left rail and generous content width; use 24–32px gutters, 20–24px panel padding, and 32–48px section gaps.
- Give each screen one composition: metric band + feed, catalog + drawer, table + inspector, or builder + test console.
- Reserve cards for meaningful groups. Dense rows may be compact; headers, empty states, and builders should breathe.

### 1.4 Typography

- **UI and prose:** Geist Sans, a clean grotesque available from Vercel's Geist package.
- **Identifiers and code:** Geist Mono for slugs, qualified tool names, IDs, `external_user_id`, aligned timestamps, JSON, and shortcuts.
- Use sentence case throughout. Avoid all-caps except tiny, infrequent technical labels.
- Default UI text is 14px/20px. Dense table metadata may use 12px/16px; never smaller.
- Page titles are 28–32px with restrained weight. The product should not depend on giant type.
- Numeric metrics use tabular figures; labels remain sans even when the value is mono.

### 1.5 eyeball identity without kitsch

No literal eyeballs, lashes, or cartoon mascots. The mark is an abstract **iris/aperture**: concentric arcs or six clean blades around a negative-space center. It may rotate a few degrees during boot, then resolve into a stable mark.

“Watching” is a state, not a slogan. Active executions and sessions use a 6px violet dot with a low-amplitude halo pulse; terminal records become static and failed records use the error mark.

### 1.6 Depth, borders, and light

- Structure comes from 1px borders and tonal layer changes, not stacked drop shadows.
- Use a soft violet outer glow only for focused, active, or live surfaces.
- Keep shadows short and diffuse on floating drawers and menus; hairlines remain visible in both themes.
- Hover raises border contrast by one step; it should not translate every card upward.
- Selected rows receive a violet inset rule or tinted fill, never both at full strength.

### 1.7 Motion

- Use 140–180ms ease-out state changes and 200–240ms drawers; animate opacity, borders, and small transforms only.
- New execution rows receive a brief settling wash; live dots pulse only while truly non-terminal.
- Charts update marks in place. Motion must be removable without losing state information.

## 2. Component stack

### 2.1 Foundation

- **Application:** Next.js App Router; server components for stable shells and initial data, client components for interaction and streaming.
- **Styling:** Tailwind CSS v4 with CSS-native tokens exposed as semantic utilities.
- **Primitives:** shadcn/ui for accessible behavior, heavily rebuilt through tokens, density variants, and eyeball composition.
- **Charts:** Recharts or an equivalent composable SVG chart library for usage trends.
- **Tables:** TanStack Table with row virtualization for execution logs and large catalogs.
- **Editors:** Lightweight JSON editor with validation, wrapping, and copy; use Monaco only if later schema tooling justifies it.
- **Icons:** One 16px stroke family. Toolkit logos may add source color inside bounded neutral tiles.

### 2.2 Design tokens

Tokens are semantic, not page-specific; components consume these names instead of hard-coded theme values.

| Token | Dark theme | Light theme | Use |
|---|---:|---:|---|
| `--bg-canvas` | `#07070A` | `#F7F7FA` | App background |
| `--bg-subtle` | `#0B0B10` | `#F1F1F5` | Sidebar, code gutter |
| `--bg-panel` | `#101016` | `#FFFFFF` | Main panels, cards |
| `--bg-raised` | `#17171F` | `#FFFFFF` | Popovers, drawers, hover |
| `--bg-code` | `#0A0A0F` | `#F4F4F8` | JSON and schema panes |
| `--border-subtle` | `#24242E` | `#E4E4EA` | Default hairlines |
| `--border-strong` | `#393946` | `#C9C9D2` | Hover, selected boundaries |
| `--text-primary` | `#F4F4F7` | `#16161B` | Titles and primary values |
| `--text-secondary` | `#A7A7B2` | `#5E5E69` | Labels and body copy |
| `--text-tertiary` | `#71717D` | `#7C7C87` | Hints and inactive metadata |
| `--accent` | `#7C5CFF` | `#6847E8` | Brand action and selection |
| `--accent-soft` | `rgba(124,92,255,.14)` | `rgba(104,71,232,.10)` | Selected tint |
| `--accent-glow` | `rgba(124,92,255,.28)` | `rgba(104,71,232,.18)` | Focus/live halo only |
| `--success` | `#38D996` | `#087A55` | Connected, succeeded |
| `--warning` | `#F2B84B` | `#996200` | Expiring, degraded |
| `--error` | `#FF667D` | `#C8324A` | Failed, revoked |
| `--radius-sm` | `6px` | `6px` | Inputs, badges, tool chips |
| `--radius-md` | `10px` | `10px` | Panels and menus |
| `--radius-lg` | `14px` | `14px` | Drawers, feature surfaces |
| `--space-unit` | `4px` | `4px` | Base spacing unit |
| `--space-scale` | `4, 8, 12, 16, 24, 32, 48, 64px` | same | Allowed layout spacing |

Accent variants are one hue at different opacity/lightness. Semantic colors require an icon and label.

### 2.3 Core component conventions

- Buttons: one violet primary per region; neutral secondary; quiet ghost; destructive red only at confirmation.
- Inputs: inset surfaces, labels, stable validation space, mono IDs, and a visible violet focus ring.
- Badges: icon + exact state word—use “connected” or “succeeded,” not vague “healthy.”
- Tables: sticky headers, column controls, keyboard selection, virtualized bodies, mono identity columns, and a side inspector.
- Drawers: 480–640px on desktop, full-screen below tablet width, and deep-linkable for entities.
- Code panes: line numbers optional, wrap toggle, copy button, search, and redaction affordance.
- Toasts: acknowledge completion; never carry the only copy of an error or recovery path.

## 3. Information architecture

### 3.1 Application shell

The shell has an aperture mark, project switcher, navigation, environment badge, help, and account controls. The project is always visible; switching it preserves the current section where possible.

Primary navigation order:

1. **Overview** — usage pulse, health, onboarding, and live activity.
2. **Toolkits** — enabled/available catalog and per-toolkit tools and schemas.
3. **Connections** — end-user connected accounts and re-authorization state.
4. **Voice Agents** — agent definitions, revisions, sessions, and builder.
5. **Executions** — real-time log stream and invocation detail.
6. **API Keys** — scoped project keys, reveal-once creation, rotation, revocation.
7. **Settings** — project profile, environments, auth configs, endpoints, and members.

### 3.2 Route map and release boundary

Later routes stay hidden until enabled, except an intentional founder-controlled preview.

| Route | Screen | MVP | Later |
|---|---|:---:|:---:|
| `/[project]/overview` | Pulse, setup, live executions | Yes | Rich cohort/cost charts |
| `/[project]/toolkits` | Searchable enabled/available catalog | Yes | Semantic capability search |
| `/[project]/toolkits/[slug]` | Toolkit tools, auth, canonical schemas | Yes | Version diff and custom tools |
| `/[project]/connections` | Accounts by user and toolkit | Yes | Bulk re-auth campaigns |
| `/[project]/connections/[id]` | Scope, expiry, event history | Yes | Audit export |
| `/[project]/executions` | Filterable, streaming execution log | Yes | Saved views and traces |
| `/[project]/executions/[id]` | Inputs, outputs, status, error | Yes | Cross-execution trace graph |
| `/[project]/api-keys` | Create, scope, rotate, revoke | Yes | Fine-grained policy templates |
| `/[project]/settings` | Project profile and environment | Yes | Members, billing, compliance |
| `/[project]/settings/auth` | Shared OAuth configuration | Yes | Bring-your-own OAuth apps |
| `/[project]/settings/endpoints` | Webhook endpoints | No | Phase 2/3 |
| `/[project]/voice-agents` | Definitions and session activity | No | Catalog 1.1 |
| `/[project]/voice-agents/new` | Builder and mock test | No | Catalog 1.1 |
| `/[project]/voice-agents/[id]` | Revision, sessions, transcript | No | Catalog 1.1 |

At MVP, Overview, Toolkits, Connections, Executions, API Keys, and Settings support the Gmail-to-logged-execution loop. Voice Agents follow with the catalog 1.1 toolkit and persistent voice runtime.

### 3.3 Entity relationships in the UI

- A project owns enabled toolkits, keys, auth configs, connections, and executions; toolkits contain canonical tools and schemas.
- A connected account belongs to one `external_user_id` and toolkit; an execution links tool, account, status, latency, I/O, and error.
- A voice-agent ID owns immutable revisions; each session pins one revision, and voice tool calls link ordinary child executions by session and turn.

Every relationship is traversable through links or the command palette, never manual ID matching.

## 4. Key screens

### 4.1 Overview — usage pulse

The overview answers three questions in ten seconds: is traffic moving, are end-user
connections usable, and are calls failing? A narrow live ticker makes the system feel active
without turning the whole page into a monitoring wall. First-run projects replace metrics
with a compact setup path until the first successful execution.

```text
+-- Acme AI / Production --------------------------- Last 24h v --+
| Good afternoon. Your agents are working.             View logs > |
|                                                                  |
| + Executions today + + Active connections + + Error rate -----+ |
| | 12,842       +18% | | 1,204          +31 | | 0.72%     -0.1% | |
| +-------------------+ +----------------------+ +----------------+ |
| Usage pulse                                      24h  7d  30d   |
| +--------------------------------------------------------------+ |
| | ___/\____/\___________      ___/\______ executions          | |
| |                     \______/        violet selected          | |
| +--------------------------------------------------------------+ |
| * LIVE  Execution ticker                           Filter v      |
| 14:32:08  gmail.send_email          184ms  Succeeded  exe_7Q2...|
| 14:32:07  notion.search_rows        91ms   Succeeded  exe_A81...|
| 14:32:05  hubspot.create_contact    2.1s   Failed     exe_F03...|
+------------------------------------------------------------------+
```

Metric cards define their values in tooltips. The chart defaults to executions with optional error-rate overlay. Ticker rows announce only when the user enables live updates.

### 4.2 Tool catalog browser

The catalog keeps **Enabled** and **Available** in one view. Search matches toolkit names, slugs, tools, and capabilities; filters express needs such as messaging, calendar, CRM, search, and no auth.
Selecting a toolkit opens a deep-linkable drawer; a tool reveals canonical I/O schemas and a try-it panel that runs deterministic development mocks.

```text
+-- Toolkits ------------------------------------------------------+
| [Search toolkits or capabilities...]  Enabled v  Auth v  Sort v |
| Chips: Messaging  Calendar  CRM  Search  Native  No auth         |
| Enabled 6                                                        |
| + Gmail / On -----+ + Slack / On -----+ + Notion / On --------+ |
| +------------------+ +------------------+ +---------------------+ |
| Available toolkits                             +-- gmail -------+|
| + HubSpot / Enable ---+ + Odoo / Enable ------+ | Tools          ||
| +----------------------+ +--------------------+ | [Filter tools] ||
| + Twilio / Enable -----------------------------+ > send_email    ||
| +----------------------------------------------+ | Schema|Try it ||
|                                                  | { mock I/O }   ||
|                                                  +---------------+|
+------------------------------------------------------------------+
```

Try-it is explicitly “Mock” and targets the project's separately configured mock executor;
it never sends an adapter base URL. Any later live mode requires deliberate account selection
and confirmation.

### 4.3 Connections — end-user account matrix

Connections are operational identity, not a logo gallery. The table is keyed by `external_user_id × toolkit`, with account, scope/expiry, last use, and recovery.
Status is exactly **Connected**, **Expired**, or **Revoked**; “Re-auth required” is an action, not a fourth status.

```text
+-- Connections ---------------------------------------------------+
| 1,204 accounts   17 need attention             [+ Create link]  |
| [Search external_user_id, account, toolkit]  Status v Toolkit v |
| User / external ID      Toolkit   Account         Status   Used  |
| ---------------------------------------------------------------- |
| user_123      [copy]    Gmail     k@acme.co       * Connected 2m |
| user_123      [copy]    Slack     Acme Workspace  * Connected 1h |
| customer_481  [copy]    HubSpot   EU Sales        ! Expired  3d |
| diner_882     [copy]    Gmail     diner@gmail...  x Revoked 12d |
|                                                   [Re-auth]      |
| Selected: customer_481 x hubspot                                |
| Connection conn_91H... [copy] - expired Jul 15 - error exe_F03...|
+------------------------------------------------------------------+
```

Re-auth names the user and toolkit, creates a hosted connect URL, and offers copy/open actions without exposing tokens. Multi-select never defaults to bulk revocation.

### 4.4 Execution detail

Execution detail is the forensic center. Its header keeps status, qualified tool, latency, mode, user, connection, and timestamps visible; a timeline handles sync and async work.
I/O panes are equal citizens. Normalized errors precede raw provider detail and offer a recovery step.

```text
+-- < Executions / exe_F03K9... -----------------------------------+
| hubspot.create_contact [copy]      x Failed  2.1s  async         |
| customer_481 - conn_91H... - Jul 16, 14:32:05.184               |
| Received -- Validated -- Auth resolved -- Provider -- x Failed  |
| 14:32:05    +12ms        +31ms             +2.0s                |
| [Input] [Output] [Events] [Metadata]              [Copy as cURL]|
| +-- Request JSON -------------+-- Response / error -------------+|
| | {                            | auth_expired                    ||
| |   "email": "[redacted]",    | Connected account expired.     ||
| |   "company": "Acme"         | Re-authorize customer_481.     ||
| | }                            | [Start re-auth]  Detail >       ||
| +------------------------------+---------------------------------+|
| Correlation: session - parent - idempotency idem_... [copy]     |
+------------------------------------------------------------------+
```

“Copy as cURL” produces a redacted, runnable eyeball API request with marked placeholders. The badge shows the normalized code; adjacent prose explains it. Provider payloads stay collapsed and redacted.

### 4.5 Voice agent builder — signature screen

This is the “show, do not tell” screen: a precise `VoiceAgentDefinition` editor beside a living test session, with advanced policy sections collapsed until needed.
The right side starts a mock call/chat, streams lifecycle and transcript events, and renders linked tool-execution chips. Saving creates an immutable revision.

```text
+-- New voice agent ---------- Draft ---------------- [Save rev 1] +
| +-- Definition 52% --------------+-- Live test 48% --------------+|
| | Name                            | Mock runtime        Ready *  ||
| | [Table Host                  ]  | [Start test call] [Chat v]   ||
| | System prompt                   | Session ses_mock_72... [copy]||
| | +----------------------------+  | created -> in-progress       ||
| | | Confirm time and email...  |  | Caller 00:03                 ||
| | +----------------------------+  | "A table for four tonight." ||
| | [default-conversation       v]  | Agent 00:05                  ||
| | Voice [Warm Host / Preview v]   | "What time works for you?"  ||
| | Allowed tools                   | +-- tool call ---------------+||
| | [Search canonical tools      ]  | | google-calendar.create_event |||
| | [google-calendar.create_event x]| | exe_mock_18... Succeeded >|||
| | [gmail.send_email x]            | +----------------------------+||
| | > Guardrails  > Webhooks        | Transcript  Events  JSON     ||
| | > Recording and retention       | [End test]                   ||
| +---------------------------------+-------------------------------+|
+------------------------------------------------------------------+
```

The voice picker previews a local sample and names provider/voice ID. The model picker stores an opaque project model reference, never credentials. Tool search uses qualified names and warns on disabled toolkits.
Guardrails cover duration, allowed hours, and handoff; webhooks, recording, and retention use the RFC fields.

The test panel exposes `created`, `connecting`, `in-progress`, `wrap-up`, and terminal states. Interim transcript text is lighter and replaced when final.
Tool chips preserve turn order and link to child executions; failed and abandoned sessions remain inspectable.

## 5. Interaction details

### 5.1 Command palette and navigation

- `⌘K` opens a project-scoped command palette from anywhere.
- Search jumps to toolkit, tool, connection, `external_user_id`, execution, voice agent, or session; results group by entity with a mono ID.
- Commands include “Create connect link,” “Open live executions,” “Create API key,” and “New voice agent.” Destructive actions stay out.
- `⌘↵` runs safe builder/test actions where shown; shortcuts are never hidden-only knowledge.
- Browser back/forward must restore drawer selection, filters, tabs, and pagination cursor.

### 5.2 IDs and copy behavior

- Every entity exposes its stable slug or ID adjacent to its human label.
- Copy targets include project ID, key prefix, toolkit/tool slug, connection ID, `external_user_id`, execution ID, agent ID/revision, and session ID.
- A copy control keeps layout stable, confirms with icon/text, and preserves the source value.
- Truncated IDs retain the full value in accessible text and on focus; never rely on hover.
- Links use human labels where possible while the nearby mono ID proves exact identity.

### 5.3 Empty states that teach

- Empty Overview: a three-step path—create key, connect user, run tool—with SDK code.
- Empty Connections: show `eb.connections.create`, explain `userId` maps to `external_user_id`, and offer “Copy snippet” and “Create test link.”
- Empty Executions: show the smallest authenticated `tools.execute` example and request-inspection help; no decorative celebration.
- Empty Voice Agents: show a minimal definition and “Build with mocks”; no telephony or model-provider account is needed for the first test.
- Filtered-empty states say which filters excluded results and offer one-click clearing.

### 5.4 Loading, streaming, and optimistic state

- Skeletons match final geometry: metric values, table rows, schema panes, and builder fields.
- Do not skeletonize the full sidebar or move navigation while project data loads.
- Toolkit enable/disable is optimistic with a pending label and rollback; active dependencies require confirmation before disabling.
- Execution rows stream without stealing selection or scroll. A “12 new” control appears when the user leaves the top.
- Live views show connection state (`Live`, `Reconnecting`, `Paused`) and last-event time.
- Revision saves are not optimistic: validate, create the immutable revision, then navigate.
- Re-auth status may update optimistically only after the hosted flow confirms completion.

### 5.5 Errors and confirmations

- Errors pair a stable taxonomy code with a plain-language cause and next action.
- Inline recovery links retain context: re-auth returns to the failed execution detail.
- Destructive confirmations name the exact project/entity and explain downstream impact.
- API secrets are reveal-once; later views show prefix, scopes, creator, and last-used time.
- Redaction is visible and explicit. A blank value must never be mistaken for a redacted one.

## 6. Accessibility and theming

### 6.1 Contrast and color

- Text and controls meet WCAG 2.2 AA in both themes: 4.5:1 for normal text and 3:1 for large text, boundaries, focus, and meaningful marks.
- Validate accent combinations independently; Iris Violet is not automatically safe as small text. Prefer it as fill, border, or large emphasis.
- Status always combines icon, label, and when useful shape or placement—not color alone.
- Charts use direct labels or a keyboard-reachable legend and offer a tabular data view.

### 6.2 Keyboard and focus

- Every workflow is keyboard-complete, including drawers, schema tabs, copy actions, recovery, filters, and voice tool selection.
- Use a consistent 2px focus indicator with offset on all themes; never remove focus styling.
- Tables use grid behavior only for interactive cells; otherwise use semantic tables, row links, and conventional Tab order.
- Virtualized tables preserve logical counts, announce sort/filter changes, and keep the focused row mounted with its inspector.
- Escape closes the topmost transient layer; it never discards a dirty form without warning.

### 6.3 Motion, streaming, and announcements

- Respect `prefers-reduced-motion`: remove pulses, transforms, chart interpolation, and smooth scrolling; preserve static state cues.
- Live feeds are not assertive regions. Announce only relevant terminal changes or a user-started test.
- Streaming transcripts expose final turns as groups; interim tokens do not trigger fragment-by-fragment announcements.
- Provide Pause for continuously updating feeds and preserve data while paused.

### 6.4 Theme behavior

- Default to the system preference on first visit, then persist an explicit user choice.
- Dark is the art direction, but light mode is designed—not an inverted afterthought.
- Both themes preserve the same layer hierarchy, semantic meanings, spacing, and typography.
- Toolkit logos sit on controlled neutral tiles so provider artwork remains legible in both.
- Code samples can use a slightly deeper surface than surrounding panels in either theme.
- Test all hover, focus, selected, disabled, loading, live, and error states in both themes.

### 6.5 Responsive behavior

- Desktop is primary, but operational inspection must remain usable on tablet and mobile.
- The nav rail collapses to a labeled sheet; the project and environment remain visible.
- Metric cards stack; tables become prioritized columns plus a full-screen row inspector.
- Execution request/response panes switch from side-by-side to tabs below 900px.
- The voice builder becomes persistent **Definition** and **Live test** tabs without losing session state.

The interface is an instrument panel for agent capability: quiet when healthy, exact when something fails, and visibly alive while eyeball is watching.
