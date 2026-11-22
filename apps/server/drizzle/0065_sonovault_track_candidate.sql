CREATE TABLE "sonovault_track_candidate" (
	"media_item_id" text NOT NULL,
	"sonovault_track_id" text NOT NULL,
	"status" text NOT NULL,
	"accepted_by" text,
	"input" text NOT NULL,
	"result" jsonb NOT NULL,
	"scrape_job_id" text,
	"response_id" text,
	"spotify_job_id" text,
	"found_at" timestamp NOT NULL,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sonovault_track_candidate_media_item_id_sonovault_track_id_pk" PRIMARY KEY("media_item_id","sonovault_track_id")
);
--> statement-breakpoint
ALTER TABLE "sonovault_track_candidate" ADD CONSTRAINT "sonovault_track_candidate_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_track_candidate" ADD CONSTRAINT "sonovault_track_candidate_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_track_candidate" ADD CONSTRAINT "sonovault_track_candidate_response_id_provider_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."provider_response"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_track_candidate" ADD CONSTRAINT "sonovault_track_candidate_spotify_job_id_scrape_job_id_fk" FOREIGN KEY ("spotify_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sonovault_track_candidate_status_idx" ON "sonovault_track_candidate" USING btree ("status","found_at");