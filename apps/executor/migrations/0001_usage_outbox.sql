CREATE TABLE "usage_outbox" (
	"execution_id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer NOT NULL,
	"next_retry_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "usage_outbox_state_retry_idx" ON "usage_outbox" USING btree ("state","next_retry_at","created_at");
