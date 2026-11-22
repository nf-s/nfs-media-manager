CREATE TABLE "sonovault_album_lookup" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"miss" text,
	"release_id" text,
	"edition_id" text,
	"confirmed_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seed_track_id" text,
	"aligned" integer DEFAULT 0 NOT NULL,
	"unaligned" integer DEFAULT 0 NOT NULL,
	"isrcs" integer DEFAULT 0 NOT NULL,
	"credits_used" integer DEFAULT 0 NOT NULL,
	"scrape_job_id" text,
	"response_id" text,
	"looked_up_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sonovault_album_lookup" ADD CONSTRAINT "sonovault_album_lookup_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_album_lookup" ADD CONSTRAINT "sonovault_album_lookup_seed_track_id_media_item_id_fk" FOREIGN KEY ("seed_track_id") REFERENCES "public"."media_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_album_lookup" ADD CONSTRAINT "sonovault_album_lookup_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sonovault_album_lookup" ADD CONSTRAINT "sonovault_album_lookup_response_id_provider_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."provider_response"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sonovault_album_lookup_looked_up_idx" ON "sonovault_album_lookup" USING btree ("status","looked_up_at");