CREATE TABLE "duplicate_review_pair" (
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"left_id" text NOT NULL,
	"right_id" text NOT NULL,
	"left_title" text NOT NULL,
	"right_title" text NOT NULL,
	"confidence" text NOT NULL,
	"decision" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"target_id" text,
	"change_id" text,
	CONSTRAINT "duplicate_review_pair_run_id_kind_left_id_right_id_pk" PRIMARY KEY("run_id","kind","left_id","right_id"),
	CONSTRAINT "duplicate_review_pair_distinct_ids" CHECK ("duplicate_review_pair"."left_id" <> "duplicate_review_pair"."right_id"),
	CONSTRAINT "duplicate_review_pair_kind" CHECK ("duplicate_review_pair"."kind" in ('track', 'album', 'artist')),
	CONSTRAINT "duplicate_review_pair_confidence" CHECK ("duplicate_review_pair"."confidence" in ('high', 'medium', 'low', 'excluded')),
	CONSTRAINT "duplicate_review_pair_decision" CHECK ("duplicate_review_pair"."decision" in ('applied', 'held', 'grouped')),
	CONSTRAINT "duplicate_review_pair_evidence" CHECK (jsonb_typeof("duplicate_review_pair"."evidence") = 'array'),
	CONSTRAINT "duplicate_review_pair_details" CHECK (jsonb_typeof("duplicate_review_pair"."details") = 'object')
);
--> statement-breakpoint
CREATE TABLE "duplicate_review_run" (
	"id" text PRIMARY KEY NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duplicate_review_pair" ADD CONSTRAINT "duplicate_review_pair_run_id_duplicate_review_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."duplicate_review_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_review_pair" ADD CONSTRAINT "duplicate_review_pair_change_id_library_change_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."library_change"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duplicate_review_pair_change_idx" ON "duplicate_review_pair" USING btree ("change_id");--> statement-breakpoint
CREATE INDEX "duplicate_review_run_recent_idx" ON "duplicate_review_run" USING btree ("reviewed_at","id");