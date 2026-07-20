CREATE TABLE "task_jobs" (
	"sequence" bigserial NOT NULL,
	"job_id" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"group_key" text,
	"group_order" bigint,
	"run_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "task_jobs_attempts_nonnegative" CHECK ("task_jobs"."attempts" >= 0),
	CONSTRAINT "task_jobs_kind_queue_check" CHECK (("task_jobs"."kind" = 'execution.run.v1' AND "task_jobs"."queue_name" = 'execution') OR ("task_jobs"."kind" = 'webhook.select.v1' AND "task_jobs"."queue_name" = 'webhook-selection') OR ("task_jobs"."kind" = 'webhook.deliver.v1' AND "task_jobs"."queue_name" = 'webhook-delivery')),
	CONSTRAINT "task_jobs_group_pair_check" CHECK (("task_jobs"."group_key" IS NULL AND "task_jobs"."group_order" IS NULL) OR ("task_jobs"."group_key" IS NOT NULL AND "task_jobs"."group_order" IS NOT NULL AND "task_jobs"."group_order" >= 0)),
	CONSTRAINT "task_jobs_state_check" CHECK ("task_jobs"."state" IN ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "task_jobs_lease_state_check" CHECK (("task_jobs"."state" = 'running' AND "task_jobs"."claimed_by" IS NOT NULL AND "task_jobs"."lease_token" IS NOT NULL AND "task_jobs"."lease_expires_at" IS NOT NULL) OR ("task_jobs"."state" <> 'running' AND "task_jobs"."claimed_by" IS NULL AND "task_jobs"."lease_token" IS NULL AND "task_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "task_jobs_completion_state_check" CHECK (("task_jobs"."state" IN ('succeeded', 'failed') AND "task_jobs"."completed_at" IS NOT NULL) OR ("task_jobs"."state" IN ('pending', 'running') AND "task_jobs"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"sequence" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"endpoint_ids" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"materialized_at" timestamp with time zone,
	CONSTRAINT "webhook_events_project_id_event_id_pk" PRIMARY KEY("project_id","event_id"),
	CONSTRAINT "webhook_events_source_kind_check" CHECK ("webhook_events"."source_kind" IN ('execution', 'trigger', 'voice-session-event', 'voice-transcript'))
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "resume_context" jsonb;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "webhook_event_id" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "webhook_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "usage_finalized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "task_jobs_queue_state_run_after_idx" ON "task_jobs" USING btree ("queue_name","state","run_after","sequence");--> statement-breakpoint
CREATE INDEX "task_jobs_queue_lease_expiry_idx" ON "task_jobs" USING btree ("queue_name","state","lease_expires_at");--> statement-breakpoint
CREATE INDEX "task_jobs_group_order_idx" ON "task_jobs" USING btree ("queue_name","group_key","group_order","sequence");--> statement-breakpoint
CREATE INDEX "webhook_events_materialization_idx" ON "webhook_events" USING btree ("materialized_at","created_at","sequence");--> statement-breakpoint
CREATE INDEX "executions_recovery_status_idx" ON "executions" USING btree ("status","sequence");--> statement-breakpoint
CREATE INDEX "executions_webhook_publication_idx" ON "executions" USING btree ("webhook_published_at","sequence");--> statement-breakpoint
CREATE INDEX "executions_usage_finalization_idx" ON "executions" USING btree ("usage_finalized_at","sequence");