CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
DROP INDEX "subscription_item_duration_idx";--> statement-breakpoint
CREATE INDEX "artist_name_search_idx" ON "artist" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "lastfm_scrobble_time_album_idx" ON "lastfm_scrobble" USING btree ("listened_at","album_media_item_id") WHERE "lastfm_scrobble"."album_media_item_id" is not null;--> statement-breakpoint
CREATE INDEX "library_track_album_name_search_idx" ON "library_track" USING gin ("album_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "library_track_added_id_idx" ON "library_track" USING btree ("date_added" DESC NULLS LAST,"media_item_id");--> statement-breakpoint
CREATE INDEX "media_credit_artist_role_media_idx" ON "media_credit" USING btree ("artist_id","role","media_item_id");--> statement-breakpoint
CREATE INDEX "media_item_title_search_idx" ON "media_item" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "media_item_summary_search_idx" ON "media_item" USING gin ("summary" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "media_item_type_release_id_idx" ON "media_item" USING btree ("media_type","release_date" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "playlist_name_search_idx" ON "playlist" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "scrape_job_created_id_idx" ON "scrape_job" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scrape_job_batch_idx" ON "scrape_job" USING btree (("options"->>'batchId'));--> statement-breakpoint
CREATE INDEX "subscription_item_title_search_idx" ON "subscription_item" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "subscription_item_duration_value_idx" ON "subscription_item" USING btree (nullif("duration_sec", 0));--> statement-breakpoint
CREATE INDEX "subscription_source_title_search_idx" ON "subscription_source" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tag_name_search_idx" ON "tag" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tag_normalized_name_search_idx" ON "tag" USING gin ((lower(btrim(regexp_replace(normalize("name", NFC), '[\s   -     　﻿]+', ' ', 'g')))) gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tag_identity_name_search_idx" ON "tag_identity" USING gin ("normalized_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tag_occurrence_raw_name_search_idx" ON "tag_occurrence" USING gin ("raw_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "track_album_title_idx" ON "track" USING btree ("album_media_item_id",lower(regexp_replace(trim("title"), '[[:space:]]+', ' ', 'g')));
