CREATE TABLE "artist_selection_member" (
	"selection_id" text NOT NULL,
	"artist_id" text NOT NULL,
	CONSTRAINT "artist_selection_member_selection_id_artist_id_pk" PRIMARY KEY("selection_id","artist_id")
);
--> statement-breakpoint
CREATE TABLE "artist_selection_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"total_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_selection_member" ADD CONSTRAINT "artist_selection_member_selection_id_artist_selection_snapshot_id_fk" FOREIGN KEY ("selection_id") REFERENCES "public"."artist_selection_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_selection_snapshot" ADD CONSTRAINT "artist_selection_snapshot_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_selection_snapshot_expiry_idx" ON "artist_selection_snapshot" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scrape_job_artist_created_idx" ON "scrape_job" USING btree ("provider",("options"->>'artistId'),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "scrape_job"."options"->>'task' = 'artist-enrichment';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scrape_job_artist_attempt_idx" ON "scrape_job" USING btree ("provider",("options"->>'artistId'),"started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "scrape_job"."options"->>'task' = 'artist-enrichment' and "scrape_job"."started_at" is not null and "scrape_job"."status" <> 'queued';