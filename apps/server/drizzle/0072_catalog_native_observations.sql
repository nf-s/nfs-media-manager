DROP INDEX "playlist_name_kind_uidx";--> statement-breakpoint
ALTER TABLE "catalog_observation" ALTER COLUMN "media_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artist" ADD COLUMN "added_to_library" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD COLUMN "target_kind" text;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD COLUMN "target_id" text;--> statement-breakpoint
UPDATE catalog_observation o SET target_kind = m.media_type::text, target_id = m.id
FROM media_item m WHERE m.id = o.media_item_id;--> statement-breakpoint
ALTER TABLE "catalog_observation" ALTER COLUMN "target_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_observation" ALTER COLUMN "target_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD COLUMN "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "catalog_observation" ADD COLUMN "import_id" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "catalog_provider" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "catalog_external_id" text;--> statement-breakpoint
ALTER TABLE "playlist" ADD COLUMN "added_to_library" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_item" ADD COLUMN "added_to_library" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_source" ADD COLUMN "added_to_library" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_observation_native_idx" ON "catalog_observation" USING btree ("target_kind","target_id","operation");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_catalog_native_uidx" ON "playlist" USING btree ("kind","catalog_provider","catalog_external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_name_kind_uidx" ON "playlist" USING btree ("name","kind") WHERE "playlist"."catalog_provider" is null;
