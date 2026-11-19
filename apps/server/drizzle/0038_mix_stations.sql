ALTER TABLE "subscription_source" DROP CONSTRAINT "subscription_source_type_check";--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "artists" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "audio_url" text;--> statement-breakpoint
ALTER TABLE "subscription_source" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "subscription_sync" ADD COLUMN "history_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_sync" ADD COLUMN "feed_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_source" ADD CONSTRAINT "subscription_source_type_check" CHECK ("subscription_source"."type" in ('youtube', 'spotify', 'rinse', 'nts', 'lotradio'));