DO $$ BEGIN
 CREATE TYPE "media_type" AS ENUM('album', 'film');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "playlist_kind" AS ENUM('playlist', 'collection');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE "album" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"date_added" timestamp,
	"duration_sec" integer,
	"track_count" integer DEFAULT 0 NOT NULL,
	"spotify_url" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artist" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_link" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "film" (
	"media_item_id" text PRIMARY KEY NOT NULL,
	"runtime_minutes" integer,
	"watched" boolean DEFAULT false NOT NULL,
	"source_kind" text,
	"budget" integer,
	"box_office" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_credit" (
	"media_item_id" text NOT NULL,
	"artist_id" text NOT NULL,
	"role" text NOT NULL,
	"billing_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "media_credit_media_item_id_artist_id_role_pk" PRIMARY KEY("media_item_id","artist_id","role")
);
--> statement-breakpoint
CREATE TABLE "media_item" (
	"id" text PRIMARY KEY NOT NULL,
	"media_type" "media_type" NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"original_title" text,
	"summary" text,
	"artwork_url" text,
	"release_date" timestamp,
	"source_label" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_item_tag" (
	"media_item_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "media_item_tag_media_item_id_tag_id_pk" PRIMARY KEY("media_item_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "media_override" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"field" text NOT NULL,
	"value" jsonb NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "playlist_kind" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playlist_item" (
	"playlist_id" text NOT NULL,
	"media_item_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "playlist_item_playlist_id_media_item_id_pk" PRIMARY KEY("playlist_id","media_item_id")
);
--> statement-breakpoint
CREATE TABLE "provider_current_state" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"latest_snapshot_id" text,
	"checksum" text NOT NULL,
	"payload" jsonb NOT NULL,
	"normalized_data" jsonb,
	"status" text NOT NULL,
	"last_successful_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_reference" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"reference_type" text NOT NULL,
	"external_id" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_reference_override" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text NOT NULL,
	"provider" text NOT NULL,
	"reference_type" text NOT NULL,
	"external_id" text NOT NULL,
	"note" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_secret" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"last_verified_at" timestamp,
	"last_verified_status" text,
	"last_updated_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_snapshot" (
	"id" text PRIMARY KEY NOT NULL,
	"media_item_id" text,
	"provider" text NOT NULL,
	"checksum" text NOT NULL,
	"payload" jsonb NOT NULL,
	"normalized_data" jsonb,
	"source" text NOT NULL,
	"scrape_job_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_job" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"scope" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"confirm_broad_run" boolean DEFAULT false NOT NULL,
	"error_message" text,
	"requested_by_user_id" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_job_item" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"media_item_id" text,
	"provider" text NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"message" text,
	"payload" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scrape_job_log" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track" (
	"id" text PRIMARY KEY NOT NULL,
	"album_media_item_id" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"duration_sec" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 3600000,
	"rate_limit_max" integer DEFAULT 10000,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"two_factor_enabled" boolean DEFAULT false,
	"is_anonymous" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "album" ADD CONSTRAINT "album_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_link" ADD CONSTRAINT "external_link_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film" ADD CONSTRAINT "film_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_credit" ADD CONSTRAINT "media_credit_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_credit" ADD CONSTRAINT "media_credit_artist_id_artist_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_item_tag" ADD CONSTRAINT "media_item_tag_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_item_tag" ADD CONSTRAINT "media_item_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_override" ADD CONSTRAINT "media_override_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_override" ADD CONSTRAINT "media_override_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_playlist_id_playlist_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlist"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_current_state" ADD CONSTRAINT "provider_current_state_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_current_state" ADD CONSTRAINT "provider_current_state_latest_snapshot_id_provider_snapshot_id_fk" FOREIGN KEY ("latest_snapshot_id") REFERENCES "public"."provider_snapshot"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_reference" ADD CONSTRAINT "provider_reference_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_reference_override" ADD CONSTRAINT "provider_reference_override_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_reference_override" ADD CONSTRAINT "provider_reference_override_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_secret" ADD CONSTRAINT "provider_secret_last_updated_by_user_id_user_id_fk" FOREIGN KEY ("last_updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_snapshot" ADD CONSTRAINT "provider_snapshot_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_snapshot" ADD CONSTRAINT "provider_snapshot_scrape_job_id_scrape_job_id_fk" FOREIGN KEY ("scrape_job_id") REFERENCES "public"."scrape_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_job" ADD CONSTRAINT "scrape_job_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_job_item" ADD CONSTRAINT "scrape_job_item_job_id_scrape_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_job_item" ADD CONSTRAINT "scrape_job_item_media_item_id_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scrape_job_log" ADD CONSTRAINT "scrape_job_log_job_id_scrape_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."scrape_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track" ADD CONSTRAINT "track_album_media_item_id_album_media_item_id_fk" FOREIGN KEY ("album_media_item_id") REFERENCES "public"."album"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_name_uidx" ON "artist" USING btree ("name");--> statement-breakpoint
CREATE INDEX "external_link_media_item_idx" ON "external_link" USING btree ("media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_item_slug_uidx" ON "media_item" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "media_item_type_idx" ON "media_item" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "media_item_title_idx" ON "media_item" USING btree ("title");--> statement-breakpoint
CREATE INDEX "media_override_media_item_idx" ON "media_override" USING btree ("media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlist_name_kind_uidx" ON "playlist" USING btree ("name","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_current_state_media_item_provider_uidx" ON "provider_current_state" USING btree ("media_item_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_reference_provider_external_uidx" ON "provider_reference" USING btree ("provider","reference_type","external_id");--> statement-breakpoint
CREATE INDEX "provider_reference_media_item_idx" ON "provider_reference" USING btree ("media_item_id");--> statement-breakpoint
CREATE INDEX "provider_reference_override_media_item_idx" ON "provider_reference_override" USING btree ("media_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_secret_provider_key_uidx" ON "provider_secret" USING btree ("provider","key");--> statement-breakpoint
CREATE INDEX "provider_snapshot_media_item_idx" ON "provider_snapshot" USING btree ("media_item_id");--> statement-breakpoint
CREATE INDEX "provider_snapshot_provider_idx" ON "provider_snapshot" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "scrape_job_status_idx" ON "scrape_job" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scrape_job_provider_idx" ON "scrape_job" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "scrape_job_item_job_idx" ON "scrape_job_item" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "scrape_job_log_job_idx" ON "scrape_job_log" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_kind_uidx" ON "tag" USING btree ("name","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "track_album_position_uidx" ON "track" USING btree ("album_media_item_id","position");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");
