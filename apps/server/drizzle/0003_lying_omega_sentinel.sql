CREATE TABLE "provider_request_state" (
	"provider" text PRIMARY KEY NOT NULL,
	"requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"next_allowed_at" timestamp,
	"cooldown_until" timestamp,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_id" text,
	"lease_until" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "provider_reference_identity_idx" ON "provider_reference" USING btree ("reference_type","external_id");