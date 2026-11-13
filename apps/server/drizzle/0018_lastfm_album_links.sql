CREATE TABLE "lastfm_album_link" (
	"username" text NOT NULL,
	"artist_key" text NOT NULL,
	"album_key" text NOT NULL,
	"album_media_item_id" text,
	"source" text NOT NULL,
	"strategy" text,
	"candidate_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lastfm_album_link_username_artist_key_album_key_pk" PRIMARY KEY("username","artist_key","album_key")
);
--> statement-breakpoint
ALTER TABLE "lastfm_album_link" ADD CONSTRAINT "lastfm_album_link_album_media_item_id_album_media_item_id_fk" FOREIGN KEY ("album_media_item_id") REFERENCES "public"."album"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lastfm_album_link_album_idx" ON "lastfm_album_link" USING btree ("album_media_item_id");