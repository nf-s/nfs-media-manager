CREATE TABLE "library_change_batch" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"change_count" integer DEFAULT 0 NOT NULL,
	"name_count" integer DEFAULT 0 NOT NULL,
	"scrobbles" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_change_effect" (
	"change_id" text NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"record_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "library_change_effect_change_id_position_pk" PRIMARY KEY("change_id","position")
);
--> statement-breakpoint
CREATE TABLE "library_keep_separate" (
	"kind" text NOT NULL,
	"low_id" text NOT NULL,
	"high_id" text NOT NULL,
	"change_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "library_keep_separate_kind_low_id_high_id_pk" PRIMARY KEY("kind","low_id","high_id")
);
--> statement-breakpoint
CREATE TABLE "library_match_rejection" (
	"username" text NOT NULL,
	"artist_key" text NOT NULL,
	"track_key" text NOT NULL,
	"record_id" text NOT NULL,
	"rule" text,
	"reason" text NOT NULL,
	"change_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "library_match_rejection_username_artist_key_track_key_record_id_pk" PRIMARY KEY("username","artist_key","track_key","record_id")
);
--> statement-breakpoint
CREATE TABLE "track_duplicate_dirty" (
	"transaction_id" bigint PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_duplicate_group" (
	"id" text PRIMARY KEY NOT NULL,
	"rule" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"cautions" jsonb NOT NULL,
	"member_count" integer NOT NULL,
	"scrobbles" integer DEFAULT 0 NOT NULL,
	"rank" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_duplicate_member" (
	"group_id" text NOT NULL,
	"track_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "track_duplicate_member_group_id_track_id_pk" PRIMARY KEY("group_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "track_duplicate_state" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"builder" text NOT NULL,
	"group_count" integer,
	"maintenance_only" boolean DEFAULT false NOT NULL,
	"retry_after" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_match_key" (
	"track_id" text PRIMARY KEY NOT NULL,
	"artist_key" text NOT NULL,
	"version_key" text NOT NULL,
	"plain_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album" ADD COLUMN "edition_of_id" text;--> statement-breakpoint
ALTER TABLE "artist" ADD COLUMN "merged_into_id" text;--> statement-breakpoint
ALTER TABLE "library_change" ADD COLUMN "batch_id" text;--> statement-breakpoint
ALTER TABLE "library_change" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "library_track" ADD COLUMN "version_group_id" text;--> statement-breakpoint
ALTER TABLE "library_track" ADD COLUMN "version_shown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "media_credit" ADD COLUMN "credited_as" text;--> statement-breakpoint
ALTER TABLE "library_change_effect" ADD CONSTRAINT "library_change_effect_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_keep_separate" ADD CONSTRAINT "library_keep_separate_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_match_rejection" ADD CONSTRAINT "library_match_rejection_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_duplicate_member" ADD CONSTRAINT "track_duplicate_member_group_id_track_duplicate_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."track_duplicate_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_match_key" ADD CONSTRAINT "track_match_key_track_id_library_track_media_item_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_change_batch_created_idx" ON "library_change_batch" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "library_change_effect_records_idx" ON "library_change_effect" USING gin ("record_ids");--> statement-breakpoint
CREATE INDEX "library_keep_separate_high_idx" ON "library_keep_separate" USING btree ("kind","high_id");--> statement-breakpoint
CREATE INDEX "library_match_rejection_change_idx" ON "library_match_rejection" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "library_match_rejection_record_idx" ON "library_match_rejection" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "track_duplicate_group_rank_idx" ON "track_duplicate_group" USING btree ("rank");--> statement-breakpoint
CREATE UNIQUE INDEX "track_duplicate_member_track_uidx" ON "track_duplicate_member" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "track_match_key_artist_version_idx" ON "track_match_key" USING btree ("artist_key","version_key");--> statement-breakpoint
ALTER TABLE "album" ADD CONSTRAINT "album_edition_of_id_album_media_item_id_fk" FOREIGN KEY ("edition_of_id") REFERENCES "public"."album"("media_item_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artist" ADD CONSTRAINT "artist_merged_into_id_artist_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."artist"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_change" ADD CONSTRAINT "library_change_batch_id_library_change_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."library_change_batch"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "album_edition_of_idx" ON "album" USING btree ("edition_of_id");--> statement-breakpoint
CREATE INDEX "artist_merged_into_idx" ON "artist" USING btree ("merged_into_id");--> statement-breakpoint
CREATE INDEX "library_change_kind_actor_created_idx" ON "library_change" USING btree ("kind","actor","created_at","id");--> statement-breakpoint
CREATE INDEX "library_change_batch_idx" ON "library_change" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "library_track_version_group_idx" ON "library_track" USING btree ("version_group_id") WHERE "library_track"."version_group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_track_version_shown_uidx" ON "library_track" USING btree ("version_group_id") WHERE "library_track"."version_shown";