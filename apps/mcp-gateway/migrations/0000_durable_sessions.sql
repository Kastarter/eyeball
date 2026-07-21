CREATE TABLE "mcp_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"protocol_version" text NOT NULL,
	"auth_binding" text NOT NULL,
	"tasks_enabled" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"catalog_version" text,
	"tasks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "mcp_sessions_expiry_after_creation" CHECK ("mcp_sessions"."expires_at" > "mcp_sessions"."created_at"),
	CONSTRAINT "mcp_sessions_tasks_object_check" CHECK (jsonb_typeof("mcp_sessions"."tasks") = 'object')
);
--> statement-breakpoint
CREATE INDEX "mcp_sessions_expiry_idx" ON "mcp_sessions" USING btree ("expires_at");