CREATE TABLE "track_tag" (
	"media_item_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"sonovault" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"response_id" text,
	"fetched_at" timestamp,
	"owner" text,
	"owner_changed_at" timestamp,
	"in_browse" boolean GENERATED ALWAYS AS (coalesce(owner = 'added', false) or (sonovault and verified and owner is null)) STORED,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "track_tag_media_item_id_tag_id_pk" PRIMARY KEY("media_item_id","tag_id"),
	CONSTRAINT "track_tag_owner" CHECK ("track_tag"."owner" is null or "track_tag"."owner" in ('added', 'removed')),
	CONSTRAINT "track_tag_has_source" CHECK ("track_tag"."sonovault" or "track_tag"."owner" is not null)
);
--> statement-breakpoint
ALTER TABLE "library_track" ADD COLUMN "has_own_tags" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "track_tag" ADD CONSTRAINT "track_tag_media_item_id_library_track_media_item_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."library_track"("media_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_tag" ADD CONSTRAINT "track_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "track_tag" ADD CONSTRAINT "track_tag_response_id_provider_response_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."provider_response"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_tag_tag_media_browse_idx" ON "track_tag" USING btree ("tag_id","media_item_id") WHERE "track_tag"."in_browse";--> statement-breakpoint
CREATE INDEX "track_tag_media_browse_idx" ON "track_tag" USING btree ("media_item_id") INCLUDE ("tag_id") WHERE "track_tag"."in_browse";--> statement-breakpoint
CREATE INDEX "track_tag_response_idx" ON "track_tag" USING btree ("response_id") WHERE "track_tag"."response_id" is not null;--> statement-breakpoint
-- TTAG-03: library_track.has_own_tags is true while the track has a row in
-- Browse whose tag is visible. Each function reads one transition table per
-- statement through EXECUTE, so a plan made for a one-row write is not reused
-- for a bulk one.
CREATE FUNCTION refresh_track_has_own_tags() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_ids text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    EXECUTE format('UPDATE %I.library_track SET has_own_tags = false WHERE has_own_tags',
      TG_TABLE_SCHEMA);
    RETURN NULL;
  END IF;
  changed_ids := CASE TG_OP
    WHEN 'INSERT' THEN 'SELECT media_item_id FROM new_rows'
    WHEN 'DELETE' THEN 'SELECT media_item_id FROM old_rows'
    ELSE 'SELECT media_item_id FROM old_rows UNION SELECT media_item_id FROM new_rows'
  END;
  EXECUTE format('UPDATE %1$I.library_track lt SET has_own_tags = own.has
    FROM (SELECT ids.id, EXISTS (
        SELECT 1 FROM %1$I.track_tag tt JOIN %1$I.tag t ON t.id = tt.tag_id
        WHERE tt.media_item_id = ids.id AND tt.in_browse AND NOT t.hidden) AS has
      FROM (SELECT DISTINCT media_item_id AS id FROM (%2$s) changed) ids) own
    WHERE lt.media_item_id = own.id AND lt.has_own_tags IS DISTINCT FROM own.has',
    TG_TABLE_SCHEMA, changed_ids);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER track_tag_own_tags_insert AFTER INSERT ON track_tag
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_track_has_own_tags();
--> statement-breakpoint
CREATE TRIGGER track_tag_own_tags_update AFTER UPDATE ON track_tag
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_track_has_own_tags();
--> statement-breakpoint
CREATE TRIGGER track_tag_own_tags_delete AFTER DELETE ON track_tag
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_track_has_own_tags();
--> statement-breakpoint
CREATE TRIGGER track_tag_own_tags_truncate AFTER TRUNCATE ON track_tag
FOR EACH STATEMENT EXECUTE FUNCTION refresh_track_has_own_tags();
--> statement-breakpoint
-- Hiding or showing a tag changes has_own_tags for the tracks carrying it.
-- Track tag writers hold the shared lock 72041/2 (lockTrackTagWrites), so
-- this recount waits for them and then sees their rows.
CREATE FUNCTION refresh_track_has_own_tags_for_tags() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed boolean;
BEGIN
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n USING (id)
    WHERE o.hidden IS DISTINCT FROM n.hidden)' INTO changed;
  IF NOT changed THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(72041, 2);
  EXECUTE format('UPDATE %1$I.library_track lt SET has_own_tags = own.has
    FROM (SELECT ids.id, EXISTS (
        SELECT 1 FROM %1$I.track_tag tt JOIN %1$I.tag t ON t.id = tt.tag_id
        WHERE tt.media_item_id = ids.id AND tt.in_browse AND NOT t.hidden) AS has
      FROM (SELECT DISTINCT tt.media_item_id AS id FROM %1$I.track_tag tt
        WHERE tt.in_browse AND tt.tag_id IN (
          SELECT n.id FROM old_rows o JOIN new_rows n USING (id)
          WHERE o.hidden IS DISTINCT FROM n.hidden)) ids) own
    WHERE lt.media_item_id = own.id AND lt.has_own_tags IS DISTINCT FROM own.has',
    TG_TABLE_SCHEMA);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER track_tag_own_tags_tag_hidden AFTER UPDATE ON tag
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION refresh_track_has_own_tags_for_tags();
--> statement-breakpoint
-- A merged tag's track rows move to the tag it was merged into, however the
-- merge is made, combining a track's rows when it had both: Sonovault's and
-- the owner's marks are kept, the owner's addition winning over a removal.
CREATE FUNCTION move_track_tags_to_alias_target() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(72041, 2);
  EXECUTE format('WITH moved AS (
      DELETE FROM %1$I.track_tag tt USING new_rows a
      WHERE tt.tag_id = a.source_tag_id
      RETURNING tt.*, a.target_tag_id
    ), combined AS (
      SELECT media_item_id, target_tag_id AS tag_id,
        bool_or(sonovault) AS sonovault,
        bool_or(sonovault AND verified) AS verified,
        (array_agg(response_id ORDER BY fetched_at DESC NULLS LAST)
          FILTER (WHERE sonovault))[1] AS response_id,
        max(fetched_at) FILTER (WHERE sonovault) AS fetched_at,
        CASE WHEN bool_or(owner = ''added'') THEN ''added''
          WHEN bool_or(owner = ''removed'') THEN ''removed'' END AS owner,
        max(owner_changed_at) AS owner_changed_at
      FROM moved GROUP BY media_item_id, target_tag_id
    )
    INSERT INTO %1$I.track_tag AS tt (media_item_id, tag_id, sonovault, verified,
      response_id, fetched_at, owner, owner_changed_at)
    SELECT media_item_id, tag_id, sonovault, verified, response_id, fetched_at,
      owner, owner_changed_at FROM combined
    ON CONFLICT (media_item_id, tag_id) DO UPDATE SET
      sonovault = tt.sonovault OR excluded.sonovault,
      verified = (tt.sonovault AND tt.verified) OR (excluded.sonovault AND excluded.verified),
      response_id = CASE WHEN excluded.sonovault AND (NOT tt.sonovault
          OR excluded.fetched_at > tt.fetched_at) THEN excluded.response_id
        ELSE tt.response_id END,
      fetched_at = CASE WHEN excluded.sonovault AND (NOT tt.sonovault
          OR excluded.fetched_at > tt.fetched_at) THEN excluded.fetched_at
        ELSE tt.fetched_at END,
      owner = CASE WHEN ''added'' IN (tt.owner, excluded.owner) THEN ''added''
        WHEN ''removed'' IN (tt.owner, excluded.owner) THEN ''removed'' END,
      owner_changed_at = greatest(tt.owner_changed_at, excluded.owner_changed_at),
      updated_at = now()', TG_TABLE_SCHEMA);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER track_tag_alias_move AFTER INSERT ON tag_alias
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION move_track_tags_to_alias_target();
--> statement-breakpoint
-- TTAG-10: track tags will be part of the stored Tracks vocabulary. They do
-- not change the recording order or the possible-duplicate groups.
CREATE TRIGGER track_facet_track_tag AFTER TRUNCATE ON track_tag
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');
--> statement-breakpoint
CREATE TRIGGER track_facet_track_tag_insert AFTER INSERT ON track_tag
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty', 'media_item_id,tag_id', 'media_item_id,tag_id,in_browse');
--> statement-breakpoint
CREATE TRIGGER track_facet_track_tag_update AFTER UPDATE ON track_tag
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty', 'media_item_id,tag_id', 'media_item_id,tag_id,in_browse');
--> statement-breakpoint
CREATE TRIGGER track_facet_track_tag_delete AFTER DELETE ON track_tag
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty', 'media_item_id,tag_id', 'media_item_id,tag_id,in_browse');
--> statement-breakpoint
-- A track's own tags are album-library tags (TTAG-01), so a track's
-- occurrences may name album tags as well as track tags, and its track_tag
-- rows name album tags.
CREATE OR REPLACE FUNCTION enforce_tag_media_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE left_scope media_type; right_scope media_type;
BEGIN
  IF TG_TABLE_NAME IN ('media_item_tag', 'tag_occurrence') THEN
    SELECT media_type INTO left_scope FROM media_item WHERE id = NEW.media_item_id FOR SHARE;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.tag_id;
    IF TG_TABLE_NAME = 'tag_occurrence' AND left_scope = 'track' AND right_scope = 'album' THEN
      left_scope := 'album';
    END IF;
  ELSIF TG_TABLE_NAME = 'track_tag' THEN
    left_scope := 'album';
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.tag_id;
  ELSIF TG_TABLE_NAME = 'tag_identity' THEN
    left_scope := NEW.media_type;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.tag_id;
  ELSE
    SELECT media_type INTO left_scope FROM tag WHERE id = NEW.source_tag_id;
    SELECT media_type INTO right_scope FROM tag WHERE id = NEW.target_tag_id;
  END IF;
  IF left_scope IS DISTINCT FROM right_scope THEN
    RAISE EXCEPTION 'Tag media scope mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER track_tag_scope BEFORE INSERT OR UPDATE OF tag_id ON track_tag FOR EACH ROW EXECUTE FUNCTION enforce_tag_media_scope();
