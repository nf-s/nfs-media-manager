DROP INDEX "scrape_job_similar_item_idx";--> statement-breakpoint
ALTER TABLE "spotify_code_lookup" ADD COLUMN "source" text DEFAULT 'spotify' NOT NULL;--> statement-breakpoint
ALTER TABLE "spotify_code_lookup" ADD COLUMN "response_id" text;--> statement-breakpoint
CREATE INDEX "scrape_job_similar_item_idx" ON "scrape_job" USING btree (("options"->>'task'),("options"->>'itemId'),"created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "scrape_job"."options"->>'task' in ('tidal-similar', 'spotify-similar-lookup', 'sonovault-similar-lookup');