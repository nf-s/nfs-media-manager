CREATE TABLE "library_import" (
	"id" text PRIMARY KEY NOT NULL,
	"status" "job_status" NOT NULL,
	"stage" text NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"result" jsonb,
	"requested_by_user_id" text,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_import" ADD CONSTRAINT "library_import_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playlist_item_media_item_idx" ON "playlist_item" USING btree ("media_item_id");