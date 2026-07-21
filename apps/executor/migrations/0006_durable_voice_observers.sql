CREATE TABLE "voice_agent_session_observers" (
	"session_id" text PRIMARY KEY NOT NULL,
	"handled_sequence" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"terminal_sequence" integer,
	"terminal_handled_at" timestamp with time zone,
	"transcript_status" text NOT NULL,
	"transcript_handled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_kind" text,
	"last_failure_operation" text,
	"last_failure_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"exhaustion_signaled_at" timestamp with time zone,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_agent_session_observers_handled_nonnegative" CHECK ("voice_agent_session_observers"."handled_sequence" >= 0),
	CONSTRAINT "voice_agent_session_observers_failures_nonnegative" CHECK ("voice_agent_session_observers"."consecutive_failures" >= 0),
	CONSTRAINT "voice_agent_session_observers_status_check" CHECK ("voice_agent_session_observers"."status" IN ('prepared', 'observing', 'finalizing', 'completed', 'exhausted', 'cancelled')),
	CONSTRAINT "voice_agent_session_observers_transcript_check" CHECK ("voice_agent_session_observers"."transcript_status" IN ('pending', 'admitted', 'skipped')),
	CONSTRAINT "voice_agent_session_observers_terminal_sequence_positive" CHECK ("voice_agent_session_observers"."terminal_sequence" IS NULL OR "voice_agent_session_observers"."terminal_sequence" >= 1),
	CONSTRAINT "voice_agent_session_observers_terminal_handling_check" CHECK ("voice_agent_session_observers"."terminal_handled_at" IS NULL OR "voice_agent_session_observers"."terminal_sequence" IS NOT NULL),
	CONSTRAINT "voice_agent_session_observers_transcript_handling_check" CHECK (("voice_agent_session_observers"."transcript_status" = 'pending' AND "voice_agent_session_observers"."transcript_handled_at" IS NULL) OR ("voice_agent_session_observers"."transcript_status" IN ('admitted', 'skipped') AND "voice_agent_session_observers"."transcript_handled_at" IS NOT NULL)),
	CONSTRAINT "voice_agent_session_observers_failure_metadata_check" CHECK (("voice_agent_session_observers"."consecutive_failures" = 0 AND "voice_agent_session_observers"."last_failure_kind" IS NULL AND "voice_agent_session_observers"."last_failure_operation" IS NULL AND "voice_agent_session_observers"."last_failure_at" IS NULL) OR ("voice_agent_session_observers"."consecutive_failures" > 0 AND "voice_agent_session_observers"."last_failure_kind" IS NOT NULL AND "voice_agent_session_observers"."last_failure_operation" IS NOT NULL AND "voice_agent_session_observers"."last_failure_at" IS NOT NULL)),
	CONSTRAINT "voice_agent_session_observers_failure_kind_check" CHECK ("voice_agent_session_observers"."last_failure_kind" IS NULL OR "voice_agent_session_observers"."last_failure_kind" IN ('provider_unavailable', 'timeout', 'invalid_response', 'publication_error', 'internal_error')),
	CONSTRAINT "voice_agent_session_observers_failure_operation_check" CHECK ("voice_agent_session_observers"."last_failure_operation" IS NULL OR "voice_agent_session_observers"."last_failure_operation" IN ('get_events', 'get_session', 'publish_event', 'publish_transcript', 'publish_failure')),
	CONSTRAINT "voice_agent_session_observers_lease_complete" CHECK (("voice_agent_session_observers"."lease_owner" IS NULL AND "voice_agent_session_observers"."lease_token" IS NULL AND "voice_agent_session_observers"."lease_expires_at" IS NULL) OR ("voice_agent_session_observers"."lease_owner" IS NOT NULL AND "voice_agent_session_observers"."lease_token" IS NOT NULL AND "voice_agent_session_observers"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "voice_agent_session_observers_exhaustion_check" CHECK (("voice_agent_session_observers"."status" = 'exhausted' AND "voice_agent_session_observers"."exhausted_at" IS NOT NULL) OR ("voice_agent_session_observers"."status" <> 'exhausted' AND "voice_agent_session_observers"."exhausted_at" IS NULL)),
	CONSTRAINT "voice_agent_session_observers_signal_check" CHECK ("voice_agent_session_observers"."exhaustion_signaled_at" IS NULL OR "voice_agent_session_observers"."exhausted_at" IS NOT NULL),
	CONSTRAINT "voice_agent_session_observers_finalization_check" CHECK ("voice_agent_session_observers"."status" NOT IN ('finalizing', 'completed') OR ("voice_agent_session_observers"."terminal_sequence" IS NOT NULL AND "voice_agent_session_observers"."terminal_handled_at" IS NOT NULL)),
	CONSTRAINT "voice_agent_session_observers_completion_check" CHECK ("voice_agent_session_observers"."status" <> 'completed' OR "voice_agent_session_observers"."transcript_status" IN ('admitted', 'skipped')),
	CONSTRAINT "voice_agent_session_observers_terminal_lease_check" CHECK (("voice_agent_session_observers"."status" NOT IN ('completed', 'cancelled') OR "voice_agent_session_observers"."lease_owner" IS NULL) AND ("voice_agent_session_observers"."status" <> 'exhausted' OR "voice_agent_session_observers"."exhaustion_signaled_at" IS NULL OR "voice_agent_session_observers"."lease_owner" IS NULL)),
	CONSTRAINT "voice_agent_session_observers_terminal_schedule_check" CHECK ("voice_agent_session_observers"."status" NOT IN ('completed', 'exhausted', 'cancelled') OR "voice_agent_session_observers"."next_attempt_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "voice_webhook_sources" (
	"project_id" text NOT NULL,
	"event_id" text NOT NULL,
	"session_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_kind" text NOT NULL,
	"worker_sequence" integer,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_webhook_sources_project_id_event_id_pk" PRIMARY KEY("project_id","event_id"),
	CONSTRAINT "voice_webhook_sources_sequence_check" CHECK (("voice_webhook_sources"."source_kind" = 'session_event' AND "voice_webhook_sources"."worker_sequence" IS NOT NULL AND "voice_webhook_sources"."worker_sequence" >= 1) OR ("voice_webhook_sources"."source_kind" IN ('transcript', 'observer_failure') AND "voice_webhook_sources"."worker_sequence" IS NULL)),
	CONSTRAINT "voice_webhook_sources_type_check" CHECK (("voice_webhook_sources"."source_kind" = 'session_event' AND "voice_webhook_sources"."event_type" = 'voice.session.event') OR ("voice_webhook_sources"."source_kind" = 'transcript' AND "voice_webhook_sources"."event_type" = 'voice.transcript.ready') OR ("voice_webhook_sources"."source_kind" = 'observer_failure' AND "voice_webhook_sources"."event_type" = 'voice.observer.failed')),
	CONSTRAINT "voice_webhook_sources_envelope_identity_check" CHECK ("voice_webhook_sources"."envelope"->>'id' = "voice_webhook_sources"."event_id" AND "voice_webhook_sources"."envelope"->>'type' = "voice_webhook_sources"."event_type" AND "voice_webhook_sources"."envelope"->>'projectId' = "voice_webhook_sources"."project_id" AND "voice_webhook_sources"."envelope"->'data'->>'sessionId' = "voice_webhook_sources"."session_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_source_kind_check";--> statement-breakpoint
ALTER TABLE "voice_agent_session_observers" ADD CONSTRAINT "voice_agent_session_observers_pointer_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_agent_session_pointers"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_webhook_sources" ADD CONSTRAINT "voice_webhook_sources_session_fk" FOREIGN KEY ("session_id") REFERENCES "public"."voice_agent_session_pointers"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "voice_agent_session_observers" (
	"session_id",
	"status",
	"transcript_status",
	"created_at",
	"updated_at"
)
SELECT
	"session_id",
	'prepared',
	'pending',
	"created_at",
	"created_at"
FROM "voice_agent_session_pointers"
ON CONFLICT ("session_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "voice_agent_session_observers_recovery_idx" ON "voice_agent_session_observers" USING btree ("status","next_attempt_at","lease_expires_at","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_webhook_sources_worker_sequence_uidx" ON "voice_webhook_sources" USING btree ("session_id","worker_sequence") WHERE "voice_webhook_sources"."worker_sequence" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "voice_webhook_sources_session_created_idx" ON "voice_webhook_sources" USING btree ("session_id","created_at","event_id");--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_kind_check" CHECK ("webhook_events"."source_kind" IN ('execution', 'trigger', 'voice-session-event', 'voice-transcript', 'voice-observer-failure'));
