CREATE TABLE "catalog_addition" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"relationship_role" text,
	"page" integer,
	"position" integer,
	"job_id" text,
	"response_id" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spotify_artist_album_listing" (
	"artist_id" text NOT NULL,
	"spotify_artist_id" text NOT NULL,
	"market" text NOT NULL,
	"pages_saved" integer DEFAULT 0 NOT NULL,
	"next_offset" integer DEFAULT 0 NOT NULL,
	"releases_seen" integer DEFAULT 0 NOT NULL,
	"expected_total" integer,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spotify_artist_album_listing_artist_id_spotify_artist_id_market_pk" PRIMARY KEY("artist_id","spotify_artist_id","market")
);
--> statement-breakpoint
DROP INDEX "artist_name_uidx";--> statement-breakpoint
ALTER TABLE "artist" ADD COLUMN "catalog_provider" text;--> statement-breakpoint
ALTER TABLE "artist" ADD COLUMN "catalog_external_id" text;--> statement-breakpoint
ALTER TABLE "media_item" ADD COLUMN "in_library" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_addition" ADD CONSTRAINT "catalog_addition_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_addition" ADD CONSTRAINT "catalog_addition_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD CONSTRAINT "catalog_observation_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD CONSTRAINT "catalog_observation_job_id_scrape_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD CONSTRAINT "catalog_observation_response_id_provider_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."provider_response"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_artist_album_listing" ADD CONSTRAINT "spotify_artist_album_listing_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_observation_target_operation_idx" ON "catalog_observation" USING btree ("media_item_id","operation");--> statement-breakpoint
CREATE INDEX "catalog_observation_subject_idx" ON "catalog_observation" USING btree ("subject_kind","subject_id","operation","media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artist_catalog_native_uidx" ON "artist" USING btree ("catalog_provider","catalog_external_id");--> statement-breakpoint
CREATE INDEX "media_item_outside_library_idx" ON "media_item" USING btree ("media_type","id") WHERE not "media_item"."in_library";--> statement-breakpoint
CREATE UNIQUE INDEX "artist_name_uidx" ON "artist" USING btree ("name") WHERE "artist"."catalog_provider" is null;