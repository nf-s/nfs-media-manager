CREATE TABLE "lastfm_track_source" (
	"username" text NOT NULL,
	"artist_key" text NOT NULL,
	"track_key" text NOT NULL,
	"track_media_item_id" text NOT NULL,
	CONSTRAINT "lastfm_track_source_username_artist_key_track_key_pk" PRIMARY KEY("username","artist_key","track_key")
);
--> statement-breakpoint
ALTER TABLE "library_track" ALTER COLUMN "spotify_track_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lastfm_track_source" ADD CONSTRAINT "lastfm_track_source_track_media_item_id_library_track_media_item_id_fk" FOREIGN KEY ("track_media_item_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lastfm_track_source_track_idx" ON "lastfm_track_source" USING btree ("track_media_item_id");