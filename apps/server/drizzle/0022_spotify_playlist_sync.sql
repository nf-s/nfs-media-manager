CREATE TABLE "spotify_playlist_listing" (
	"user_id" text PRIMARY KEY NOT NULL,
	"playlists" jsonb NOT NULL,
	"listed_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "sync_schedule" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "sync_user_id" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "spotify_editable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "spotify_playlist_listing" ADD CONSTRAINT "spotify_playlist_listing_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist" ADD CONSTRAINT "playlist_sync_user_id_user_id_fk" FOREIGN KEY ("sync_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;