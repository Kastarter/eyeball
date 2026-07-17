CREATE TABLE "execution_idempotency" (
	"project_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"tool" text NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"catalog_major" text NOT NULL,
	"request_hash" text NOT NULL,
	"execution_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_connection_id" text,
	CONSTRAINT "execution_idempotency_project_id_idempotency_key_tool_user_id_connection_id_catalog_major_pk" PRIMARY KEY("project_id","idempotency_key","tool","user_id","connection_id","catalog_major")
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"sequence" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"execution_id" text NOT NULL,
	"status" text NOT NULL,
	"tool" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL,
	"request" jsonb NOT NULL,
	"idempotency_key" text,
	"resolved_connection_id" text,
	CONSTRAINT "executions_project_id_execution_id_pk" PRIMARY KEY("project_id","execution_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_dedup_claims" (
	"subscription_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trigger_dedup_claims_subscription_id_provider_event_id_pk" PRIMARY KEY("subscription_id","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_states" (
	"subscription_id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"next_poll_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_subscriptions" (
	"sequence" bigserial NOT NULL,
	"subscription_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"trigger" text NOT NULL,
	"connection_id" text,
	"webhook_endpoint_ids" jsonb NOT NULL,
	"filters" jsonb,
	"poll_interval_seconds" integer,
	"status" text NOT NULL,
	"ingest_secret_hash" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"sequence" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"next_retry_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_project_id_delivery_id_pk" PRIMARY KEY("project_id","delivery_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_delivery_attempts" (
	"project_id" text NOT NULL,
	"delivery_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"status_code" integer,
	"error" text,
	CONSTRAINT "webhook_delivery_attempts_project_id_delivery_id_attempt_pk" PRIMARY KEY("project_id","delivery_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"sequence" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"secret_prefix" text NOT NULL,
	"events" jsonb NOT NULL,
	"active" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "webhook_endpoints_project_id_endpoint_id_pk" PRIMARY KEY("project_id","endpoint_id")
);
--> statement-breakpoint
ALTER TABLE "execution_idempotency" ADD CONSTRAINT "execution_idempotency_execution_fk" FOREIGN KEY ("project_id","execution_id") REFERENCES "public"."executions"("project_id","execution_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_delivery_fk" FOREIGN KEY ("project_id","delivery_id") REFERENCES "public"."webhook_deliveries"("project_id","delivery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_idempotency_expiry_idx" ON "execution_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "executions_project_time_idx" ON "executions" USING btree ("project_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "executions_project_status_time_idx" ON "executions" USING btree ("project_id","status","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "executions_project_tool_time_idx" ON "executions" USING btree ("project_id","tool","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "executions_project_user_time_idx" ON "executions" USING btree ("project_id","user_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_dedup_claims_expiry_idx" ON "trigger_dedup_claims" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "trigger_subscriptions_project_time_idx" ON "trigger_subscriptions" USING btree ("project_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_subscriptions_project_user_time_idx" ON "trigger_subscriptions" USING btree ("project_id","user_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trigger_subscriptions_active_idx" ON "trigger_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_time_idx" ON "webhook_deliveries" USING btree ("project_id","endpoint_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_retry_idx" ON "webhook_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_project_time_idx" ON "webhook_endpoints" USING btree ("project_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_endpoints_project_active_idx" ON "webhook_endpoints" USING btree ("project_id","active");