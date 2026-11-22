CREATE TABLE "spotify_code_lookup" (
	"code_type" text NOT NULL,
	"code" text NOT NULL,
	"spotify_id" text,
	"result" jsonb,
	"scrape_job_id" text,
	"searched_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_code_lookup_code_type_code_pk" PRIMARY KEY("code_type","code")
);
--> statement-breakpoint
CREATE TABLE "tidal_similar" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"scrape_job_id" text,
	"read_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spotify_code_lookup" ADD CONSTRAINT "spotify_code_lookup_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tidal_similar" ADD CONSTRAINT "tidal_similar_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tidal_similar" ADD CONSTRAINT "tidal_similar_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_job_similar_item_idx" ON "scrape_job" USING btree (("options"->>'task'),("options"->>'itemId'),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "scrape_job"."options"->>'task' in ('tidal-similar', 'spotify-similar-lookup');