CREATE TABLE "trigger_events" (
	"sequence" bigserial NOT NULL,
	"arrival_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"trigger" text NOT NULL,
	"delivery_mode" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dedup_status" text NOT NULL,
	"delivery_admission_status" text NOT NULL,
	"requested_webhook_endpoint_ids" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trigger_events_delivery_mode_check" CHECK ("trigger_events"."delivery_mode" IN ('push', 'polling')),
	CONSTRAINT "trigger_events_dedup_status_check" CHECK ("trigger_events"."dedup_status" IN ('accepted', 'duplicate')),
	CONSTRAINT "trigger_events_delivery_admission_status_check" CHECK ("trigger_events"."delivery_admission_status" IN ('admitted', 'failed', 'not_enqueued')),
	CONSTRAINT "trigger_events_status_consistency_check" CHECK (("trigger_events"."dedup_status" = 'duplicate' AND "trigger_events"."delivery_admission_status" = 'not_enqueued') OR ("trigger_events"."dedup_status" = 'accepted' AND "trigger_events"."delivery_admission_status" IN ('admitted', 'failed'))),
	CONSTRAINT "trigger_events_requested_endpoint_ids_array_check" CHECK (jsonb_typeof("trigger_events"."requested_webhook_endpoint_ids") = 'array'),
	CONSTRAINT "trigger_events_expiry_after_received_check" CHECK ("trigger_events"."expires_at" > "trigger_events"."received_at")
);
--> statement-breakpoint
CREATE INDEX "trigger_events_project_received_idx" ON "trigger_events" USING btree ("project_id","received_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_events_project_subscription_received_idx" ON "trigger_events" USING btree ("project_id","subscription_id","received_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_events_project_trigger_received_idx" ON "trigger_events" USING btree ("project_id","trigger","received_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_events_expiry_idx" ON "trigger_events" USING btree ("expires_at","sequence");--> statement-breakpoint
CREATE INDEX "trigger_events_project_event_idx" ON "trigger_events" USING btree ("project_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_project_event_idx" ON "webhook_deliveries" USING btree ("project_id","event_id","sequence");