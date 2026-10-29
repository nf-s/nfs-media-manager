CREATE TABLE "provider_cooldown_reset" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"previous_cooldown_until" timestamp NOT NULL,
	"cleared_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "provider_request_event" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"requested_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_request_state" ADD COLUMN "history_started_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_cooldown_reset" ADD CONSTRAINT "provider_cooldown_reset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_cooldown_reset_provider_time_idx" ON "provider_cooldown_reset" USING btree ("provider","cleared_at");--> statement-breakpoint
CREATE INDEX "provider_request_event_provider_time_idx" ON "provider_request_event" USING btree ("provider","requested_at");--> statement-breakpoint
INSERT INTO "provider_request_event" ("id", "provider", "requested_at")
SELECT 'legacy:' || s.provider || ':' || r.ordinality::text || ':' || r.value,
  s.provider, to_timestamp(r.value::double precision / 1000) AT TIME ZONE 'UTC'
FROM "provider_request_state" s,
  jsonb_array_elements_text(s.requests) WITH ORDINALITY AS r(value, ordinality)
ON CONFLICT DO NOTHING;
