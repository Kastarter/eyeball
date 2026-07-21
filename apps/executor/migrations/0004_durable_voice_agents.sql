CREATE TABLE "voice_agent_message_receipts" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"message" text NOT NULL,
	"user_message_id" text NOT NULL,
	"assistant_message" text NOT NULL,
	CONSTRAINT "voice_agent_message_receipts_project_id_user_id_session_id_client_message_id_pk" PRIMARY KEY("project_id","user_id","session_id","client_message_id")
);
--> statement-breakpoint
CREATE TABLE "voice_agent_number_bindings" (
	"project_id" text NOT NULL,
	"phone_number" text NOT NULL,
	"binding_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"revision" integer NOT NULL,
	"transport_connection_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_agent_number_bindings_project_id_phone_number_pk" PRIMARY KEY("project_id","phone_number"),
	CONSTRAINT "voice_agent_number_bindings_revision_positive" CHECK ("voice_agent_number_bindings"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "voice_agent_revisions" (
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_agent_revisions_project_id_agent_id_revision_pk" PRIMARY KEY("project_id","agent_id","revision"),
	CONSTRAINT "voice_agent_revisions_revision_positive" CHECK ("voice_agent_revisions"."revision" >= 1),
	CONSTRAINT "voice_agent_revisions_definition_id_check" CHECK ("voice_agent_revisions"."definition"->>'id' = "voice_agent_revisions"."agent_id"),
	CONSTRAINT "voice_agent_revisions_definition_revision_check" CHECK (("voice_agent_revisions"."definition"->>'revision')::integer = "voice_agent_revisions"."revision")
);
--> statement-breakpoint
CREATE TABLE "voice_agent_session_pointers" (
	"session_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_revision" integer NOT NULL,
	"call_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_agent_session_pointers_revision_positive" CHECK ("voice_agent_session_pointers"."agent_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "voice_agents" (
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"active_revision" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "voice_agents_project_id_agent_id_pk" PRIMARY KEY("project_id","agent_id"),
	CONSTRAINT "voice_agents_active_revision_positive" CHECK ("voice_agents"."active_revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "voice_agent_number_bindings" ADD CONSTRAINT "voice_agent_number_bindings_revision_fk" FOREIGN KEY ("project_id","agent_id","revision") REFERENCES "public"."voice_agent_revisions"("project_id","agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_agent_revisions" ADD CONSTRAINT "voice_agent_revisions_agent_fk" FOREIGN KEY ("project_id","agent_id") REFERENCES "public"."voice_agents"("project_id","agent_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_agent_session_pointers" ADD CONSTRAINT "voice_agent_session_pointers_revision_fk" FOREIGN KEY ("project_id","agent_id","agent_revision") REFERENCES "public"."voice_agent_revisions"("project_id","agent_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_agent_number_bindings_binding_id_uidx" ON "voice_agent_number_bindings" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "voice_agent_number_bindings_project_phone_idx" ON "voice_agent_number_bindings" USING btree ("project_id","phone_number","binding_id");--> statement-breakpoint
CREATE INDEX "voice_agent_session_pointers_scope_created_idx" ON "voice_agent_session_pointers" USING btree ("project_id","user_id","created_at" DESC NULLS LAST,"session_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "voice_agents_project_created_idx" ON "voice_agents" USING btree ("project_id","created_at","agent_id");