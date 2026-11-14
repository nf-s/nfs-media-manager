CREATE TABLE "subscription_short" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"run_id" text
);
--> statement-breakpoint
ALTER TABLE "subscription_source" ADD COLUMN "shorts_run_id" text;--> statement-breakpoint
ALTER TABLE "subscription_sync" ADD COLUMN "shorts_page_token" text;--> statement-breakpoint
ALTER TABLE "subscription_short" ADD CONSTRAINT "subscription_short_source_id_subscription_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."subscription_source"("id") ON DELETE cascade ON UPDATE no action;