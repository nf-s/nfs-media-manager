CREATE TABLE "youtube_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"handle" text,
	"description" text,
	"thumbnail_url" text,
	"uploads_playlist_id" text,
	"subscriber_count" bigint,
	"subscribed" boolean DEFAULT true NOT NULL,
	"seen_run_id" text,
	"history_complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_sync" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"schedule" text DEFAULT 'daily' NOT NULL,
	"run_id" text,
	"phase" text DEFAULT 'subscriptions' NOT NULL,
	"page_token" text,
	"channel_cursor" text,
	"channels_done" integer DEFAULT 0 NOT NULL,
	"channels_total" integer DEFAULT 0 NOT NULL,
	"new_videos" integer DEFAULT 0 NOT NULL,
	"resume_after" timestamp,
	"error_message" text,
	"lease_token" text,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_video" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp NOT NULL,
	"duration_sec" integer DEFAULT 0 NOT NULL,
	"view_count" bigint,
	"like_count" bigint,
	"comment_count" bigint,
	"live" text DEFAULT 'none' NOT NULL,
	"search" "tsvector" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_sync" ADD CONSTRAINT "youtube_sync_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_video" ADD CONSTRAINT "youtube_video_channel_id_youtube_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."youtube_channel"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "youtube_channel_subscribed_idx" ON "youtube_channel" USING btree ("subscribed","id");--> statement-breakpoint
CREATE INDEX "youtube_video_search_idx" ON "youtube_video" USING gin ("search");--> statement-breakpoint
CREATE INDEX "youtube_video_channel_published_idx" ON "youtube_video" USING btree ("channel_id","published_at");--> statement-breakpoint
CREATE INDEX "youtube_video_published_idx" ON "youtube_video" USING btree ("published_at","id");--> statement-breakpoint
CREATE INDEX "youtube_video_views_idx" ON "youtube_video" USING btree ("view_count");--> statement-breakpoint
CREATE INDEX "youtube_video_duration_idx" ON "youtube_video" USING btree ("duration_sec");