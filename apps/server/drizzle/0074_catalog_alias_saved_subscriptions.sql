CREATE TABLE "catalog_media_alias" (
	"alias_id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	CONSTRAINT "catalog_media_alias_distinct" CHECK ("catalog_media_alias"."alias_id" <> "catalog_media_alias"."media_item_id")
);
--> statement-breakpoint
ALTER TABLE "catalog_media_alias" ADD CONSTRAINT "catalog_media_alias_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_media_alias_target_idx" ON "catalog_media_alias" USING btree ("media_item_id");--> statement-breakpoint
CREATE INDEX "subscription_item_added_source_idx" ON "subscription_item" USING btree ("source_id","id") WHERE "subscription_item"."added_to_library";