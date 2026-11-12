CREATE INDEX "media_item_type_title_id_idx" ON "media_item" USING btree ("media_type",lower("title"),"id");--> statement-breakpoint
CREATE INDEX "provider_request_event_class_time_idx" ON "provider_request_event" USING btree ("provider","request_class","requested_at");--> statement-breakpoint
CREATE INDEX "provider_snapshot_job_time_idx" ON "provider_snapshot" USING btree ("scrape_job_id","created_at","id");--> statement-breakpoint
CREATE INDEX "provider_snapshot_media_time_idx" ON "provider_snapshot" USING btree ("media_item_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scrape_job_dispatch_idx" ON "scrape_job" USING btree ("provider","status","created_at","id");--> statement-breakpoint
CREATE INDEX "scrape_job_queued_provider_idx" ON "scrape_job" USING btree ("status","provider");--> statement-breakpoint
CREATE INDEX "scrape_job_item_latest_idx" ON "scrape_job_item" USING btree ("provider","media_item_id","started_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "scrape_job_item_media_history_idx" ON "scrape_job_item" USING btree ("media_item_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);