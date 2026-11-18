CREATE TABLE "lastfm_play" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"track_uri" text NOT NULL,
	"artist" text NOT NULL,
	"track" text NOT NULL,
	"album" text DEFAULT '' NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"ignored_code" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp,
	CONSTRAINT "lastfm_play_status_check" CHECK ("lastfm_play"."status" in ('waiting', 'sent', 'ignored'))
);
--> statement-breakpoint
ALTER TABLE "lastfm_play" ADD CONSTRAINT "lastfm_play_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lastfm_play_user_track_time_idx" ON "lastfm_play" USING btree ("user_id","track_uri","started_at");--> statement-breakpoint
CREATE INDEX "lastfm_play_waiting_idx" ON "lastfm_play" USING btree ("user_id","started_at") WHERE "lastfm_play"."status" = 'waiting';