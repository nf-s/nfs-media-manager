CREATE TABLE "artist_provider_current_state" (
	"artist_id" text NOT NULL,
	"provider" text NOT NULL,
	"latest_snapshot_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artist_provider_current_state_artist_id_provider_pk" PRIMARY KEY("artist_id","provider")
);
--> statement-breakpoint
CREATE TABLE "artist_provider_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"artist_id" text NOT NULL,
	"provider" text NOT NULL,
	"payload" jsonb NOT NULL,
	"normalized_data" jsonb NOT NULL,
	"scrape_job_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "artist_provider_current_state" ADD CONSTRAINT "artist_provider_current_state_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_provider_current_state" ADD CONSTRAINT "artist_provider_current_state_latest_snapshot_id_artist_provider_snapshot_id_fk" FOREIGN KEY ("latest_snapshot_id") REFERENCES "public"."artist_provider_snapshot"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_provider_snapshot" ADD CONSTRAINT "artist_provider_snapshot_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist_provider_snapshot" ADD CONSTRAINT "artist_provider_snapshot_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_provider_snapshot_artist_time_idx" ON "artist_provider_snapshot" USING btree ("artist_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);