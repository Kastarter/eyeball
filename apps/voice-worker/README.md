# Eyeball voice worker

The voice worker is the persistent control-plane implementation of
`eyeball.voice-worker.v1`. It durably owns session state, ordered events, and
child-dispatch recovery while the TypeScript executor remains the trusted
boundary for canonical tool calls, credentials, webhooks, and execution
records. The repository also contains Pipecat, Twilio, and LiveKit integration
paths for real-provider certification.

The account-free suite proves the worker HTTP contract, deterministic fake and
chat behavior, durable recovery, and mocked provider request assembly. It does
not open media sockets, place calls, validate provider SDK behavior, or prove
live-call capability. Twilio, LiveKit, Deepgram, Anthropic, and ElevenLabs must
all be certified with real credentials before use.

## Run contract tests

```bash
PYTHONPATH=src python -m pytest
```

The fake transport is rejected unless both of these test-only settings are
enabled:

```text
EYEBALL_VOICE_MEDIA_MODE=fake
EYEBALL_VOICE_ALLOW_FAKE_TRANSPORT=true
```

## Run the container

Set a control token shared with the executor, plus a user-pinned executor key:

```bash
export EYEBALL_VOICE_WORKER_TOKEN='replace-with-a-long-random-token'
export EYEBALL_VOICE_WORKER_KEY='ey_live_user_pinned_key'
cp .env.example .env
docker compose --env-file .env up --build
```

Then configure the executor with the same control token and the worker URL:

```text
EYEBALL_VOICE_WORKER_URL=http://127.0.0.1:8080
EYEBALL_VOICE_WORKER_TOKEN=replace-with-a-long-random-token
```

`GET /health` is public. Its `media.liveReady` field reports configuration
presence only; it does not probe providers or certify a call path. Every
`/v1/sessions/*` HTTP request and event WebSocket requires the wire-version
header and, when configured, the bearer control token.

## Deploy one Fly Machine for certification

Create the durable volume in the same region you will deploy, set provider
credentials as secrets, and keep exactly one Machine attached to the volume:

```bash
fly volumes create voice_worker_data --region <region> --size 10 --app <app>
fly secrets set --app <app> \
  EYEBALL_VOICE_WORKER_TOKEN='...' \
  EYEBALL_VOICE_WORKER_KEY='...' \
  EYEBALL_EXECUTOR_URL='https://executor.example.com' \
  EYEBALL_VOICE_PUBLIC_URL='https://<app>.fly.dev' \
  ANTHROPIC_API_KEY='...' \
  DEEPGRAM_API_KEY='...' \
  ELEVENLABS_API_KEY='...'
fly deploy --app <app> --region <region>
```

Add either the Twilio secrets, the LiveKit secrets, or both from the table
below. The checked-in `fly.toml` disables scale-to-zero and keeps one Machine
running because a SQLite volume cannot be mounted by multiple replicas.

## Provider-certification settings

| Variable | Purpose |
| --- | --- |
| `EYEBALL_VOICE_WORKER_TOKEN` | Shared executor-to-worker control token; required in `pipecat` mode. |
| `EYEBALL_VOICE_WORKER_KEY` | User-pinned executor API key used only for child tool execution. |
| `EYEBALL_EXECUTOR_URL` | Trusted executor origin; defaults to `http://127.0.0.1:8787`. |
| `EYEBALL_VOICE_DATABASE_PATH` | SQLite state path; defaults to `.eyeball/voice-worker.sqlite3`. |
| `EYEBALL_VOICE_PUBLIC_URL` | Public HTTPS origin used to construct Twilio media WebSocket URLs. |
| `ANTHROPIC_API_KEY` | Anthropic model credential for the Pipecat turn loop. |
| `DEEPGRAM_API_KEY` | Streaming speech-to-text credential. |
| `ELEVENLABS_API_KEY` | Streaming text-to-speech credential. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Outbound PSTN configuration. |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | WebRTC room configuration. |

The worker stores no provider credentials in session snapshots or events.
Child calls persist `tool_call` before dispatch, reserve the same `exe_*`
identity at the executor, and derive
`voice-session:<sessionId>:event:<sequence>` as the retry key.

## Operations and recovery

- Run exactly one replica per SQLite volume. Multi-replica scheduling requires
  a distributed repository and lease, which this worker does not provide.
- Keep `/var/lib/eyeball` on durable storage and back up the SQLite database
  together with its WAL files.
- Allow at least 30 seconds for `SIGTERM`; shutdown stops admission, drains
  active tasks, then marks overdue sessions abandoned.
- Fake and chat sessions resume from durable cursors. An unresolved child tool
  call reuses its stored execution ID and idempotency key after restart.
- The configured media recovery policy marks an interrupted carrier session
  failed instead of silently starting a second call. This policy still awaits
  end-to-end provider certification.
- One static `EYEBALL_VOICE_WORKER_KEY` represents one pinned executor user.
  Multi-user hosted deployments need short-lived per-session executor
  authorization, which is outside this open-core worker.
