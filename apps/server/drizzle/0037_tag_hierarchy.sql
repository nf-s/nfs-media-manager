CREATE TABLE "tag_ancestor" (
	"media_type" "media_type" NOT NULL,
	"descendant_key" text NOT NULL,
	"ancestor_key" text NOT NULL,
	CONSTRAINT "tag_ancestor_media_type_descendant_key_ancestor_key_pk" PRIMARY KEY("media_type","descendant_key","ancestor_key")
);
--> statement-breakpoint
CREATE TABLE "tag_parent" (
	"media_type" "media_type" NOT NULL,
	"child_key" text NOT NULL,
	"parent_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_parent_media_type_child_key_parent_key_pk" PRIMARY KEY("media_type","child_key","parent_key"),
	CONSTRAINT "tag_parent_not_self" CHECK ("tag_parent"."child_key" <> "tag_parent"."parent_key")
);
--> statement-breakpoint
CREATE INDEX "tag_ancestor_ancestor_idx" ON "tag_ancestor" USING btree ("media_type","ancestor_key");--> statement-breakpoint
CREATE INDEX "tag_parent_parent_idx" ON "tag_parent" USING btree ("media_type","parent_key");--> statement-breakpoint
CREATE INDEX "tag_media_type_name_key_idx" ON "tag" USING btree ("media_type",(lower(btrim(regexp_replace(normalize("name", NFC), '[\s   -     　﻿]+', ' ', 'g')))));