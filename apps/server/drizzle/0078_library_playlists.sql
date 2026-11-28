CREATE TABLE "library_playlist" (
	"id" text PRIMARY KEY NOT NULL,
	"library" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"view" jsonb,
	"legacy_key" text,
	"created_by_user_id" text,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "library_playlist_library_check" CHECK ("library_playlist"."library" in ('albums', 'tracks', 'films', 'subscriptions', 'mixes')),
	CONSTRAINT "library_playlist_type_check" CHECK ("library_playlist"."type" in ('playlist', 'smart')),
	CONSTRAINT "library_playlist_name_check" CHECK (char_length("library_playlist"."name") between 1 and 200 and "library_playlist"."name" = btrim("library_playlist"."name")),
	CONSTRAINT "library_playlist_view_check" CHECK (("library_playlist"."type" = 'smart') = ("library_playlist"."view" is not null) and ("library_playlist"."view" is null or jsonb_typeof("library_playlist"."view") = 'object')),
	CONSTRAINT "library_playlist_legacy_key_check" CHECK ("library_playlist"."legacy_key" is null or "library_playlist"."type" = 'smart')
);
--> statement-breakpoint
CREATE TABLE "library_playlist_entry" (
	"id" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"position" integer NOT NULL,
	"media_item_id" text,
	"subscription_item_id" text,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"batch_id" text NOT NULL,
	"removed_batch_id" text,
	"removed_at" timestamp,
	CONSTRAINT "library_playlist_entry_item_check" CHECK (num_nonnulls("library_playlist_entry"."media_item_id", "library_playlist_entry"."subscription_item_id") = 1),
	CONSTRAINT "library_playlist_entry_removed_check" CHECK (("library_playlist_entry"."removed_batch_id" is null) = ("library_playlist_entry"."removed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "library_playlist" ADD CONSTRAINT "library_playlist_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_playlist_entry" ADD CONSTRAINT "library_playlist_entry_playlist_id_library_playlist_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."library_playlist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_playlist_entry" ADD CONSTRAINT "library_playlist_entry_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_playlist_entry" ADD CONSTRAINT "library_playlist_entry_subscription_item_id_subscription_item_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_playlist_name_uidx" ON "library_playlist" USING btree ("library",lower("name")) WHERE "library_playlist"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_playlist_legacy_key_uidx" ON "library_playlist" USING btree ("legacy_key");--> statement-breakpoint
CREATE INDEX "library_playlist_deleted_idx" ON "library_playlist" USING btree ("deleted_at") WHERE "library_playlist"."deleted_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_playlist_entry_position_uidx" ON "library_playlist_entry" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "library_playlist_entry_batch_idx" ON "library_playlist_entry" USING btree ("playlist_id","batch_id");--> statement-breakpoint
CREATE INDEX "library_playlist_entry_removed_idx" ON "library_playlist_entry" USING btree ("removed_at") WHERE "library_playlist_entry"."removed_at" is not null;--> statement-breakpoint
CREATE INDEX "library_playlist_entry_media_item_idx" ON "library_playlist_entry" USING btree ("media_item_id","playlist_id") WHERE "library_playlist_entry"."media_item_id" is not null;--> statement-breakpoint
CREATE INDEX "library_playlist_entry_subscription_item_idx" ON "library_playlist_entry" USING btree ("subscription_item_id","playlist_id") WHERE "library_playlist_entry"."subscription_item_id" is not null;