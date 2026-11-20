CREATE TABLE "recording_browse_order_member" (
	"track_id" text PRIMARY KEY NOT NULL,
	"recording_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recording_browse_order_member_recording_idx" ON "recording_browse_order_member" USING btree ("recording_id");