import { randomUUID } from "node:crypto";
import type { VoiceAgentDraft } from "@eyeball/core";
import { expect, it } from "vitest";
import { createPgStoreBundle, PostgresAgentStore } from "../src/index.js";

const databaseUrl = process.env.EYEBALL_TEST_DATABASE_URL?.trim();

const agentDraft: VoiceAgentDraft = {
  name: "Postgres session-pointer race agent",
  systemPrompt: "Keep the durable session pointer pinned.",
  llm: { model: "model:fixture:postgres-pointer-race" },
  voice: {
    tts: { provider: "elevenlabs", voiceId: "voice_pointer_race" },
    stt: { provider: "deepgram", model: "nova-3" },
  },
  transport: "pstn:twilio",
  tools: [],
  guardrails: {
    maxDurationSeconds: 300,
    handoffToHuman: { enabled: false },
  },
  webhooks: { endpointIds: [], transcript: true, events: [] },
  recordingPolicy: {
    mode: "audio_and_transcript",
    consent: "agent_announcement",
    retentionDays: 7,
    redactDtmf: true,
  },
};

it.runIf(databaseUrl !== undefined && databaseUrl.length > 0)(
  "keeps the first session scope pinned under concurrent PostgreSQL writes",
  async () => {
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error("EYEBALL_TEST_DATABASE_URL is required for this test.");
    }

    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `voice_pointer_race_${suffix}`;
    const functionName = `voice_pointer_race_sleep_${suffix}`;
    const sessionId = `session_pointer_race_${suffix}`;
    const scopes = [
      {
        projectId: `project_pointer_race_a_${suffix}`,
        userId: `user_pointer_race_a_${suffix}`,
        callId: `call_pointer_race_a_${suffix}`,
        createdAt: "2026-07-20T03:30:00.000Z",
      },
      {
        projectId: `project_pointer_race_b_${suffix}`,
        userId: `user_pointer_race_b_${suffix}`,
        callId: `call_pointer_race_b_${suffix}`,
        createdAt: "2026-07-20T03:30:01.000Z",
      },
    ] as const;
    const bundle = await createPgStoreBundle({
      connectionString: databaseUrl,
      maxConnections: 2,
    });

    try {
      const firstConnection = await bundle.pool.connect();
      const secondConnection = await bundle.pool.connect();
      try {
        const [firstBackend, secondBackend] = await Promise.all([
          firstConnection.query<{ pid: number }>(
            "select pg_backend_pid()::integer as pid",
          ),
          secondConnection.query<{ pid: number }>(
            "select pg_backend_pid()::integer as pid",
          ),
        ]);
        expect(firstBackend.rows[0]?.pid).not.toBe(secondBackend.rows[0]?.pid);
      } finally {
        secondConnection.release();
        firstConnection.release();
      }

      const agents = await Promise.all(
        scopes.map((scope, index) =>
          bundle.agentStore.createAgent(
            scope.projectId,
            { ...agentDraft, name: `${agentDraft.name} ${index + 1}` },
            scope.createdAt,
          ),
        ),
      );
      const candidates = scopes.map((scope, index) => ({
        ...scope,
        sessionId,
        agentId: agents[index]?.id ?? "",
        agentRevision: 1,
      }));
      if (candidates.some(({ agentId }) => agentId.length === 0)) {
        throw new Error("Expected both PostgreSQL race agents.");
      }

      await bundle.pool.query(`
        create function ${functionName}() returns trigger
        language plpgsql
        as $function$
        begin
          perform pg_sleep(0.25);
          return new;
        end;
        $function$
      `);
      await bundle.pool.query(`
        create trigger ${triggerName}
        after insert on voice_agent_session_pointers
        for each row execute function ${functionName}()
      `);

      const firstStore = new PostgresAgentStore(bundle.database);
      const secondStore = new PostgresAgentStore(bundle.database);
      const outcomes = await Promise.allSettled([
        firstStore.rememberSession(candidates[0]),
        secondStore.rememberSession(candidates[1]),
      ]);

      expect(
        outcomes.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
      const rejected = outcomes.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("session scope changed"),
        }),
      });

      const winnerIndex = outcomes.findIndex(
        ({ status }) => status === "fulfilled",
      );
      const winner = candidates[winnerIndex];
      const loser = candidates[winnerIndex === 0 ? 1 : 0];
      if (winner === undefined || loser === undefined) {
        throw new Error("Expected one PostgreSQL session-pointer winner.");
      }

      await expect(
        firstStore.getSession(
          winner.projectId,
          winner.userId,
          winner.sessionId,
        ),
      ).resolves.toEqual(winner);
      await expect(
        secondStore.getSession(loser.projectId, loser.userId, loser.sessionId),
      ).rejects.toMatchObject({ code: "not_found" });
      const persisted = await bundle.pool.query<{
        agent_id: string;
        agent_revision: number;
        call_id: string;
        project_id: string;
        user_id: string;
      }>(
        `select project_id, user_id, agent_id, agent_revision, call_id
           from voice_agent_session_pointers
          where session_id = $1`,
        [sessionId],
      );
      expect(persisted.rows).toEqual([
        {
          project_id: winner.projectId,
          user_id: winner.userId,
          agent_id: winner.agentId,
          agent_revision: winner.agentRevision,
          call_id: winner.callId,
        },
      ]);
    } finally {
      await bundle.pool.query(
        `drop trigger if exists ${triggerName} on voice_agent_session_pointers`,
      );
      await bundle.pool.query(`drop function if exists ${functionName}()`);
      await bundle.pool.query(
        "delete from voice_agent_session_pointers where session_id = $1",
        [sessionId],
      );
      await bundle.pool.query(
        "delete from voice_agent_revisions where project_id = any($1::text[])",
        [scopes.map(({ projectId }) => projectId)],
      );
      await bundle.pool.query(
        "delete from voice_agents where project_id = any($1::text[])",
        [scopes.map(({ projectId }) => projectId)],
      );
      await bundle.close();
    }
  },
  30_000,
);
