CREATE TABLE "spotify_track_match_audit" (
	"owner_id" text NOT NULL,
	"track_id" text NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assessment" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"search_text" text NOT NULL,
	"report" jsonb NOT NULL,
	CONSTRAINT "spotify_track_match_audit_owner_id_track_id_pk" PRIMARY KEY("owner_id","track_id")
);
--> statement-breakpoint
ALTER TABLE "spotify_track_match_audit" ADD CONSTRAINT "spotify_track_match_audit_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spotify_track_match_audit" ADD CONSTRAINT "spotify_track_match_audit_track_id_library_track_media_item_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;