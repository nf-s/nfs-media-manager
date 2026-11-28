CREATE TABLE "device_pairing" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apikey" ADD COLUMN "kind" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_pairing" ADD CONSTRAINT "device_pairing_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairing_code_hash_idx" ON "device_pairing" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "device_pairing_user_id_idx" ON "device_pairing" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_kind_check" CHECK ("apikey"."kind" in ('api', 'device'));--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON device_pairing TO media_runtime;
  END IF;
END;
$$;