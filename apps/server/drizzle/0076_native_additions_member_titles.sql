CREATE TABLE "catalog_native_addition" (
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"owner_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_native_addition_target_kind_target_id_pk" PRIMARY KEY("target_kind","target_id")
);
--> statement-breakpoint
ALTER TABLE "catalog_native_addition" ADD CONSTRAINT "catalog_native_addition_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_item_library_title_idx" ON "media_item" USING btree ("media_type",lower("title"),"id") WHERE "media_item"."in_library";