CREATE TABLE "track_fact" (
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"bpm" double precision,
	"key_camelot" text,
	"key_musical" text,
	"key_open" text,
	"key_source" text,
	"verified" boolean NOT NULL,
	"response_id" text,
	"fetched_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "track_fact_media_item_id_provider_pk" PRIMARY KEY("media_item_id","provider"),
	CONSTRAINT "track_fact_bpm_range" CHECK ("track_fact"."bpm" is null or ("track_fact"."bpm" > 0 and "track_fact"."bpm" <= 1000)),
	CONSTRAINT "track_fact_key_camelot" CHECK ("track_fact"."key_camelot" is null or "track_fact"."key_camelot" ~ '^(1[0-2]|[1-9])[AB]$')
);
--> statement-breakpoint
ALTER TABLE "track_fact" ADD CONSTRAINT "track_fact_media_item_id_library_track_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_fact" ADD CONSTRAINT "track_fact_response_id_provider_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."provider_response"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_fact_verified_bpm_idx" ON "track_fact" USING btree ("provider","bpm") WHERE "track_fact"."verified" and "track_fact"."bpm" is not null;--> statement-breakpoint
CREATE INDEX "track_fact_verified_key_idx" ON "track_fact" USING btree ("provider","key_camelot") WHERE "track_fact"."verified" and "track_fact"."key_camelot" is not null;--> statement-breakpoint
CREATE INDEX "track_fact_response_idx" ON "track_fact" USING btree ("response_id") WHERE "track_fact"."response_id" is not null;--> statement-breakpoint
-- The Key field is in the track facet vocabulary.
CREATE TRIGGER track_facet_track_fact
AFTER INSERT OR UPDATE OF media_item_id, provider, key_camelot, verified OR DELETE OR TRUNCATE ON "track_fact"
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');
