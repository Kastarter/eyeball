import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type {
  VoiceWebhookSourceAdmission,
  VoiceWebhookSourceRecord,
  VoiceWebhookSourceStore,
} from "../../webhooks/voice-source-store.js";
import { normalizeVoiceWebhookSourceAdmission } from "../../webhooks/voice-source-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { voiceWebhookSources } from "./schema.js";

function fromRow(
  row: typeof voiceWebhookSources.$inferSelect,
): VoiceWebhookSourceRecord {
  return structuredClone({
    projectId: row.projectId,
    eventId: row.eventId,
    sessionId: row.sessionId,
    eventType: row.eventType,
    sourceKind: row.sourceKind,
    ...(row.workerSequence === null
      ? {}
      : { workerSequence: row.workerSequence }),
    envelope: row.envelope,
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

export class PostgresVoiceWebhookSourceStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements VoiceWebhookSourceStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;

  constructor(database: EyeballPostgresDatabase<TQueryResult>) {
    this.#database = database;
  }

  async ensureSource(
    input: VoiceWebhookSourceAdmission,
  ): Promise<"inserted" | "existing"> {
    const incoming = normalizeVoiceWebhookSourceAdmission(input);
    const [inserted] = await this.#database
      .insert(voiceWebhookSources)
      .values({
        projectId: incoming.projectId,
        eventId: incoming.eventId,
        sessionId: incoming.sessionId,
        eventType: incoming.eventType,
        sourceKind: incoming.sourceKind,
        workerSequence: incoming.workerSequence ?? null,
        envelope: incoming.envelope,
        createdAt: incoming.createdAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted !== undefined) return "inserted";
    const existing = await this.getSource(incoming.projectId, incoming.eventId);
    if (existing === undefined || !isDeepStrictEqual(existing, incoming)) {
      throw new Error(
        "Voice webhook source identity was reused with different content.",
      );
    }
    return "existing";
  }

  async getSource(
    projectId: string,
    eventId: string,
  ): Promise<VoiceWebhookSourceRecord | undefined> {
    const [row] = await this.#database
      .select()
      .from(voiceWebhookSources)
      .where(
        and(
          eq(voiceWebhookSources.projectId, projectId),
          eq(voiceWebhookSources.eventId, eventId),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : fromRow(row);
  }
}
