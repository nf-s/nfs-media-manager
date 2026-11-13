ALTER TYPE "public"."media_type" ADD VALUE IF NOT EXISTS 'track';--> statement-breakpoint
CREATE TABLE "lastfm_track_link" (
	"username" text NOT NULL,
	"artist_key" text NOT NULL,
	"track_key" text NOT NULL,
	"track_media_item_id" text NOT NULL,
	"strategy" text NOT NULL,
	CONSTRAINT "lastfm_track_link_username_artist_key_track_key_track_media_item_id_pk" PRIMARY KEY("username","artist_key","track_key","track_media_item_id")
);
--> statement-breakpoint
CREATE TABLE "library_track" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"spotify_track_id" text NOT NULL,
	"isrc" text,
	"duration_sec" integer,
	"date_added" timestamp,
	"spotify_url" text,
	"album_name" text,
	"spotify_album_id" text,
	"album_media_item_id" text,
	"album_link_strategy" text,
	"scrobble_count" integer DEFAULT 0 NOT NULL,
	"last_listened_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "spotify_id" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "owner_name" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "artwork_url" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "spotify_url" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "imported_at" timestamp;--> statement-breakpoint
ALTER TABLE "playlist_item" ADD COLUMN "added_at" timestamp;--> statement-breakpoint
ALTER TABLE "lastfm_track_link" ADD CONSTRAINT "lastfm_track_link_track_media_item_id_library_track_media_item_id_fk" FOREIGN KEY ("track_media_item_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_track" ADD CONSTRAINT "library_track_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_track" ADD CONSTRAINT "library_track_album_media_item_id_album_media_item_id_fk" FOREIGN KEY ("album_media_item_id") REFERENCES "public"."album"("media_item_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lastfm_track_link_track_idx" ON "lastfm_track_link" USING btree ("track_media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_track_spotify_track_uidx" ON "library_track" USING btree ("spotify_track_id");--> statement-breakpoint
CREATE INDEX "library_track_album_idx" ON "library_track" USING btree ("album_media_item_id");--> statement-breakpoint
CREATE INDEX "library_track_spotify_album_idx" ON "library_track" USING btree ("spotify_album_id");--> statement-breakpoint
CREATE INDEX "lastfm_scrobble_track_idx" ON "lastfm_scrobble" USING btree ("track_key","artist_key");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_spotify_id_uidx" ON "playlist" USING btree ("spotify_id");