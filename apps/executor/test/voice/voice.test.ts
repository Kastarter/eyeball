import { beforeAll, describe, expect, it } from "vitest";
import {
  hasMocksCheckout,
  loadMocksModule,
  mocksSuiteTitle,
} from "../mocks-checkout.js";

type VoiceMocksModule =
  typeof import("../../../../mocks/packages/mocks-voice/dist/index.js");
type VoiceHelpersModule = typeof import("./helpers.js");

let createDeepgramMock: VoiceMocksModule["createDeepgramMock"];
let createElevenLabsMock: VoiceMocksModule["createElevenLabsMock"];
let createLiveKitMock: VoiceMocksModule["createLiveKitMock"];
let createPipecatMock: VoiceMocksModule["createPipecatMock"];
let createTwilioMock: VoiceMocksModule["createTwilioMock"];
let createVoiceMockHarness: VoiceHelpersModule["createVoiceMockHarness"];
let output: VoiceHelpersModule["output"];
const mocksAvailable = hasMocksCheckout();

describe.skipIf(!mocksAvailable)(
  mocksSuiteTitle("P0 voice adapters", mocksAvailable),
  () => {
    beforeAll(async () => {
      const [mocks, helpers] = await Promise.all([
        loadMocksModule<VoiceMocksModule>("mocks-voice"),
        import("./helpers.js") as Promise<VoiceHelpersModule>,
      ]);
      ({
        createDeepgramMock,
        createElevenLabsMock,
        createLiveKitMock,
        createPipecatMock,
        createTwilioMock,
      } = mocks);
      ({ createVoiceMockHarness, output } = helpers);
    });

    it("runs the complete Twilio call-control surface through the executor", async () => {
      const provider = createTwilioMock();
      const harness = createVoiceMockHarness(provider, {
        type: "basic",
        username: "ACfixture",
        password: "fixture:valid",
      });

      const started = await harness.execute(
        "twilio.start_call",
        { to: "+15550001111", from: "+15550002222" },
        "async",
      );
      expect(started.initialStatus).toBe(202);
      expect(started.initial.status).toBe("pending");
      const initialCall = output(started);
      expect(initialCall).toMatchObject({
        callId: expect.any(String),
        state: "queued",
        to: "+15550001111",
        from: "+15550002222",
        direction: "outbound",
      });
      const callId = String(initialCall.callId);

      expect(
        output(await harness.execute("twilio.get_call", { callId })).state,
      ).toBe("queued");

      provider.advanceClock(3_000);
      expect(
        output(await harness.execute("twilio.get_call", { callId })).state,
      ).toBe("in-progress");

      expect(
        output(
          await harness.execute("twilio.send_dtmf", { callId, digits: "12#" }),
        ),
      ).toEqual({ callId, state: "in-progress", digitsSent: "12#" });

      const transferred = output(
        await harness.execute("twilio.transfer_call", {
          callId,
          to: "+15550003333",
        }),
      );
      expect(transferred).toMatchObject({
        callId,
        to: "+15550003333",
        transfers: ["+15550003333"],
      });

      const ended = output(
        await harness.execute("twilio.end_call", { callId }),
      );
      expect(ended.state).toBe("completed");

      const listed = output(
        await harness.execute("twilio.list_calls", { state: "completed" }),
      );
      expect(listed.calls).toEqual([
        expect.objectContaining({ callId, state: "completed" }),
      ]);
    });

    it("surfaces deterministic Twilio carrier failure states", async () => {
      const provider = createTwilioMock();
      const harness = createVoiceMockHarness(provider, {
        type: "basic",
        username: "ACfixture",
        password: "fixture:valid",
      });
      const started = output(
        await harness.execute(
          "twilio.start_call",
          { to: "+15550000911", from: "+15550002222" },
          "async",
        ),
      );
      provider.advanceClock(3_000);
      expect(
        output(
          await harness.execute("twilio.get_call", {
            callId: String(started.callId),
          }),
        ).state,
      ).toBe("busy");
    });

    it("creates a LiveKit room and deterministic participant credentials", async () => {
      const provider = createLiveKitMock();
      const harness = createVoiceMockHarness(provider, {
        type: "api_key",
        values: { apiKey: "fixture:key", apiSecret: "fixture:secret" },
      });
      const room = output(
        await harness.execute("livekit.create_room", {
          roomName: "reservation-room",
        }),
      );
      expect(room).toMatchObject({
        roomId: expect.any(String),
        roomName: "reservation-room",
        state: "created",
        participantCount: 0,
      });

      const joined = output(
        await harness.execute("livekit.join_room", {
          roomName: "reservation-room",
          participantIdentity: "caller-481",
          participantName: "Caller Fixture",
        }),
      );
      expect(joined).toMatchObject({
        roomId: room.roomId,
        roomName: "reservation-room",
        participantId: expect.any(String),
        participantIdentity: "caller-481",
        token: expect.stringMatching(/^[^.]+\.[^.]+\.[^.]+$/u),
      });
    });

    it("normalizes deterministic ElevenLabs synthesis and Deepgram transcription", async () => {
      const elevenLabs = createVoiceMockHarness(createElevenLabsMock(), {
        type: "api_key",
        values: { apiKey: "fixture:valid" },
      });
      const speech = output(
        await elevenLabs.execute("elevenlabs.synthesize_speech", {
          text: "Welcome to the deterministic voice fixture.",
          voiceId: "voice_fixture_aria",
          audioFormat: "mp3",
        }),
      );
      expect(speech).toMatchObject({
        audioRef: expect.stringMatching(/^fixture:tts:/u),
        characters: 43,
        audioFormat: "mp3",
      });
      expect(
        output(
          await elevenLabs.execute("elevenlabs.synthesize_speech", {
            text: "Welcome to the deterministic voice fixture.",
            voiceId: "voice_fixture_aria",
            audioFormat: "mp3",
          }),
        ).audioRef,
      ).toBe(speech.audioRef);

      const deepgram = createVoiceMockHarness(createDeepgramMock(), {
        type: "api_key",
        values: { apiKey: "fixture:valid" },
      });
      const transcript = output(
        await deepgram.execute("deepgram.transcribe_audio", {
          audioRef: "fixture:audio:hello",
          language: "en",
        }),
      );
      expect(transcript).toMatchObject({
        text: "Hello from the Deepgram fixture.",
        confidence: 0.99,
        language: "en",
        words: expect.arrayContaining([
          expect.objectContaining({ word: "Hello", startMs: 0, endMs: 350 }),
        ]),
      });
    });

    it("pins trusted project and user scope into Pipecat pipelines", async () => {
      const provider = createPipecatMock();
      const harness = createVoiceMockHarness(provider, { type: "none" });
      const started = await harness.execute(
        "pipecat.start_voice_pipeline",
        {
          agentConfig: {
            projectId: "untrusted-project",
            userId: "untrusted-user",
            agentId: "agent_table_host",
            agentRevision: 3,
            transport: "pstn:twilio",
          },
        },
        "async",
      );
      const pipeline = output(started).pipeline as Readonly<
        Record<string, unknown>
      >;
      expect(pipeline).toMatchObject({
        projectId: "proj_voice_mocks",
        userId: "user_voice_mocks",
        agentId: "agent_table_host",
        agentRevision: 3,
        state: "created",
      });

      provider.advanceClock(2_000);
      const current = output(
        await harness.execute("pipecat.get_voice_pipeline", {
          pipelineId: String(pipeline.pipelineId),
        }),
      ).pipeline as Readonly<Record<string, unknown>>;
      expect(current).toMatchObject({
        state: "in-progress",
        lastEventSequence: 3,
      });
    });
  },
);
