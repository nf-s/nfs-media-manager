CREATE TABLE "film_import_preview" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by_user_id" text,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"records" jsonb NOT NULL,
	"claimed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_current_state" ADD COLUMN "last_scraped_at" timestamp;--> statement-breakpoint
ALTER TABLE "film_import_preview" ADD CONSTRAINT "film_import_preview_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_current_state_freshness_idx" ON "provider_current_state" USING btree ("provider","last_scraped_at");
--> statement-breakpoint
UPDATE provider_current_state AS state
SET last_scraped_at = completed.finished_at
FROM (
  SELECT media_item_id, provider, max(finished_at) AS finished_at
  FROM scrape_job_item
  WHERE status = 'succeeded'
  GROUP BY media_item_id, provider
) AS completed
WHERE state.media_item_id = completed.media_item_id AND state.provider = completed.provider;
