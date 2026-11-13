-- Custom SQL migration file, put your code below! --
-- Generalises the YouTube tables to subscription sources, items and sync
-- checkpoints of more than one provider. Renames and column additions with
-- constant defaults change only the catalog; no stored video is rewritten.
-- Every existing row is YouTube. The CHECK constraint and the new index read
-- only the source table, which holds one row per subscribed channel.
ALTER TABLE "youtube_channel" RENAME TO "subscription_source";--> statement-breakpoint
ALTER INDEX "youtube_channel_pkey" RENAME TO "subscription_source_pkey";--> statement-breakpoint
ALTER TABLE "subscription_source" ADD COLUMN "type" text DEFAULT 'youtube' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_source" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscription_source" ADD COLUMN "item_total" integer;--> statement-breakpoint
ALTER TABLE "subscription_source" ADD CONSTRAINT "subscription_source_type_check" CHECK ("subscription_source"."type" in ('youtube', 'spotify'));--> statement-breakpoint
DROP INDEX "youtube_channel_subscribed_idx";--> statement-breakpoint
CREATE INDEX "subscription_source_type_subscribed_idx" ON "subscription_source" USING btree ("type","subscribed","id");--> statement-breakpoint
ALTER TABLE "youtube_video" RENAME TO "subscription_item";--> statement-breakpoint
ALTER INDEX "youtube_video_pkey" RENAME TO "subscription_item_pkey";--> statement-breakpoint
ALTER TABLE "subscription_item" RENAME COLUMN "channel_id" TO "source_id";--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "type" text DEFAULT 'youtube' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_item" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "published_precision" text DEFAULT 'time' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "artwork_url" text;--> statement-breakpoint
ALTER TABLE "subscription_item" RENAME CONSTRAINT "youtube_video_channel_id_youtube_channel_id_fk" TO "subscription_item_source_id_subscription_source_id_fk";--> statement-breakpoint
ALTER INDEX "youtube_video_search_idx" RENAME TO "subscription_item_search_idx";--> statement-breakpoint
ALTER INDEX "youtube_video_channel_published_idx" RENAME TO "subscription_item_source_published_idx";--> statement-breakpoint
ALTER INDEX "youtube_video_published_idx" RENAME TO "subscription_item_published_idx";--> statement-breakpoint
ALTER INDEX "youtube_video_views_idx" RENAME TO "subscription_item_views_idx";--> statement-breakpoint
ALTER INDEX "youtube_video_duration_idx" RENAME TO "subscription_item_duration_idx";--> statement-breakpoint
ALTER TABLE "youtube_sync" RENAME TO "subscription_sync";--> statement-breakpoint
ALTER TABLE "subscription_sync" ADD COLUMN "provider" text DEFAULT 'youtube' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_sync" ALTER COLUMN "provider" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscription_sync" DROP CONSTRAINT "youtube_sync_pkey";--> statement-breakpoint
ALTER TABLE "subscription_sync" ADD CONSTRAINT "subscription_sync_user_id_provider_pk" PRIMARY KEY("user_id","provider");--> statement-breakpoint
ALTER TABLE "subscription_sync" RENAME CONSTRAINT "youtube_sync_user_id_user_id_fk" TO "subscription_sync_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "subscription_sync" RENAME COLUMN "channel_cursor" TO "source_cursor";--> statement-breakpoint
ALTER TABLE "subscription_sync" RENAME COLUMN "channels_done" TO "sources_done";--> statement-breakpoint
ALTER TABLE "subscription_sync" RENAME COLUMN "channels_total" TO "sources_total";--> statement-breakpoint
ALTER TABLE "subscription_sync" RENAME COLUMN "new_videos" TO "new_items";--> statement-breakpoint
UPDATE "subscription_sync" SET "phase" = CASE "phase" WHEN 'videos' THEN 'items' ELSE 'sources' END;--> statement-breakpoint
ALTER TABLE "subscription_sync" ALTER COLUMN "phase" SET DEFAULT 'sources';
