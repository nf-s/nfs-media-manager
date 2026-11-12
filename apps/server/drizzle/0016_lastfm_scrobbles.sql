CREATE TABLE "lastfm_scrobble" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"listened_at" timestamp NOT NULL,
	"artist_name" text NOT NULL,
	"album_name" text,
	"track_name" text NOT NULL,
	"artist_key" text NOT NULL,
	"album_key" text,
	"track_key" text NOT NULL,
	"artist_mbid" text,
	"album_mbid" text,
	"track_mbid" text,
	"album_media_item_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lastfm_sync" (
	"username" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"window_from" bigint,
	"window_to" bigint NOT NULL,
	"next_page" integer DEFAULT 1 NOT NULL,
	"total_pages" integer,
	"new_scrobbles" integer DEFAULT 0 NOT NULL,
	"synced_through" bigint,
	"error_message" text,
	"lease_token" text,
	"lease_until" timestamp,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"requested_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lastfm_scrobble" ADD CONSTRAINT "lastfm_scrobble_album_media_item_id_album_media_item_id_fk" FOREIGN KEY ("album_media_item_id") REFERENCES "public"."album"("media_item_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lastfm_sync" ADD CONSTRAINT "lastfm_sync_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lastfm_scrobble_album_time_idx" ON "lastfm_scrobble" USING btree ("album_media_item_id","listened_at");--> statement-breakpoint
CREATE INDEX "lastfm_scrobble_name_idx" ON "lastfm_scrobble" USING btree ("album_key","artist_key");--> statement-breakpoint
CREATE INDEX "lastfm_scrobble_user_time_idx" ON "lastfm_scrobble" USING btree ("username","listened_at");