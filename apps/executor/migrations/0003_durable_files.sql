CREATE TABLE "staged_files" (
	"sequence" bigserial NOT NULL,
	"project_id" text NOT NULL,
	"file_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" bigint NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staged_files_project_id_file_id_pk" PRIMARY KEY("project_id","file_id"),
	CONSTRAINT "staged_files_size_nonnegative" CHECK ("staged_files"."size" >= 0),
	CONSTRAINT "staged_files_content_size_check" CHECK (octet_length("staged_files"."content") = "staged_files"."size"),
	CONSTRAINT "staged_files_expiry_after_creation" CHECK ("staged_files"."expires_at" > "staged_files"."created_at"),
	CONSTRAINT "staged_files_name_length_check" CHECK (octet_length("staged_files"."name") BETWEEN 1 AND 255),
	CONSTRAINT "staged_files_mime_type_length_check" CHECK (char_length("staged_files"."mime_type") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX "staged_files_project_created_idx" ON "staged_files" USING btree ("project_id","created_at" DESC NULLS LAST,"sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "staged_files_expiry_idx" ON "staged_files" USING btree ("expires_at","sequence");