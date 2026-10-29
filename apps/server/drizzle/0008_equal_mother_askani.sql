CREATE TABLE "tag_alias" (
	"source_tag_id" text PRIMARY KEY NOT NULL,
	"target_tag_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_alias_not_self" CHECK ("tag_alias"."source_tag_id" <> "tag_alias"."target_tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag_identity" (
	"normalized_name" text NOT NULL,
	"kind" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "tag_identity_normalized_name_kind_pk" PRIMARY KEY("normalized_name","kind")
);
--> statement-breakpoint
CREATE TABLE "tag_merge" (
	"id" text PRIMARY KEY NOT NULL,
	"source_tag_id" text NOT NULL,
	"target_tag_id" text NOT NULL,
	"requested_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag_occurrence" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"provider" text,
	"source" text,
	"source_id" text,
	"raw_name" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tag_alias" ADD CONSTRAINT "tag_alias_source_tag_id_tag_id_fk" FOREIGN KEY ("source_tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_alias" ADD CONSTRAINT "tag_alias_target_tag_id_tag_id_fk" FOREIGN KEY ("target_tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_identity" ADD CONSTRAINT "tag_identity_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_merge" ADD CONSTRAINT "tag_merge_source_tag_id_tag_id_fk" FOREIGN KEY ("source_tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_merge" ADD CONSTRAINT "tag_merge_target_tag_id_tag_id_fk" FOREIGN KEY ("target_tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_merge" ADD CONSTRAINT "tag_merge_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_occurrence" ADD CONSTRAINT "tag_occurrence_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_occurrence" ADD CONSTRAINT "tag_occurrence_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tag_alias_target_idx" ON "tag_alias" USING btree ("target_tag_id");--> statement-breakpoint
CREATE INDEX "tag_identity_tag_idx" ON "tag_identity" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tag_occurrence_tag_idx" ON "tag_occurrence" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "tag_occurrence_media_idx" ON "tag_occurrence" USING btree ("media_item_id");--> statement-breakpoint
-- Preserve every existing membership without guessing its provider or upstream.
INSERT INTO "tag_occurrence" ("id", "media_item_id", "tag_id", "raw_name", "kind")
SELECT 'legacy_tagocc_' || md5(jsonb_build_array(m."media_item_id", m."tag_id")::text),
       m."media_item_id", m."tag_id", t."name", t."kind"
FROM "media_item_tag" m JOIN "tag" t ON t."id" = m."tag_id";
--> statement-breakpoint
-- Match tagDisplayName/normalizeTagName: NFC, ECMAScript whitespace, lowercase.
-- Do not strip accents, punctuation, prefixes or hyphens from historical names.
CREATE TEMPORARY TABLE "tag_migration_identity" ON COMMIT DROP AS
WITH normalized AS (
  SELECT "id" AS source_tag_id, "kind",
         lower(btrim(regexp_replace(normalize("name", NFC), U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+', ' ', 'g'))) AS normalized_name
  FROM "tag"
)
SELECT *, min(source_tag_id) OVER (PARTITION BY normalized_name, "kind") AS target_tag_id
FROM normalized;
--> statement-breakpoint
INSERT INTO "tag_identity" ("normalized_name", "kind", "tag_id")
SELECT DISTINCT normalized_name, "kind", target_tag_id FROM "tag_migration_identity";
--> statement-breakpoint
INSERT INTO "tag_alias" ("source_tag_id", "target_tag_id")
SELECT source_tag_id, target_tag_id FROM "tag_migration_identity" WHERE source_tag_id <> target_tag_id;
--> statement-breakpoint
INSERT INTO "media_item_tag" ("media_item_id", "tag_id")
SELECT DISTINCT m."media_item_id", i.target_tag_id
FROM "media_item_tag" m JOIN "tag_migration_identity" i ON i.source_tag_id = m."tag_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "tag_occurrence" o SET "tag_id" = i.target_tag_id
FROM "tag_migration_identity" i WHERE o."tag_id" = i.source_tag_id;
--> statement-breakpoint
DELETE FROM "media_item_tag" m USING "tag_alias" a WHERE m."tag_id" = a."source_tag_id";
