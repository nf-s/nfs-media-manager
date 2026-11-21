CREATE TABLE "library_change" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"rule" text,
	"target" jsonb,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scrobbles" integer DEFAULT 0 NOT NULL,
	"reversible" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"undone_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "library_change_move" (
	"change_id" text NOT NULL,
	"username" text NOT NULL,
	"artist_key" text NOT NULL,
	"track_key" text NOT NULL,
	"artist_name" text NOT NULL,
	"track_name" text NOT NULL,
	"scrobbles" integer DEFAULT 0 NOT NULL,
	"from_id" text NOT NULL,
	"from_manual" boolean NOT NULL,
	"to_id" text NOT NULL,
	"to_manual" boolean NOT NULL,
	CONSTRAINT "library_change_move_change_id_username_artist_key_track_key_pk" PRIMARY KEY("change_id","username","artist_key","track_key")
);
--> statement-breakpoint
CREATE TABLE "library_change_removal" (
	"change_id" text NOT NULL,
	"record_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "library_change_removal_change_id_record_id_pk" PRIMARY KEY("change_id","record_id")
);
--> statement-breakpoint
ALTER TABLE "library_change_move" ADD CONSTRAINT "library_change_move_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_change_removal" ADD CONSTRAINT "library_change_removal_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_change_kind_created_idx" ON "library_change" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "library_change_move_from_idx" ON "library_change_move" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "library_change_move_to_idx" ON "library_change_move" USING btree ("to_id");