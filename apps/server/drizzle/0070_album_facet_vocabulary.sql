CREATE TABLE "album_facet_dirty" (
	"transaction_id" bigint PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_facet_state" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"builder" text NOT NULL,
	"ready" boolean DEFAULT false NOT NULL,
	"maintenance_only" boolean DEFAULT false NOT NULL,
	"retry_after" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "album_facet_value" (
	"field" text NOT NULL,
	"rank" bigint NOT NULL,
	"value" text NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "album_facet_value_field_rank_pk" PRIMARY KEY("field","rank")
);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Extend the existing transaction marker protocol to the Album vocabulary.
CREATE OR REPLACE FUNCTION mark_browse_cache_dirty() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  writes integer;
  writer bigint;
  markers text;
  from_rows text;
  key_columns text;
  media_id text;
  tag_id text;
  relevant text := 'true';
  differences text := 'true';
  changed boolean;
BEGIN
  IF TG_ARGV[0] IS NULL OR TG_ARGV[0] NOT IN ('track_facet_dirty', 'album_facet_dirty', 'recording_browse_order_dirty', 'track_duplicate_dirty') THEN
    RAISE EXCEPTION 'Unexpected Browse cache marker table';
  END IF;
  markers := format('%I.%I', TG_TABLE_SCHEMA, TG_ARGV[0]);

  IF TG_TABLE_NAME = 'artist_provider_current_state' AND TG_OP <> 'TRUNCATE' THEN
    from_rows := CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT NULL::text AS prior_id, latest_snapshot_id AS next_id FROM new_rows'
      WHEN 'DELETE' THEN 'SELECT latest_snapshot_id AS prior_id, NULL::text AS next_id FROM old_rows'
      ELSE 'SELECT old_rows.latest_snapshot_id AS prior_id, new_rows.latest_snapshot_id AS next_id
        FROM old_rows FULL JOIN new_rows USING (artist_id, provider)
        WHERE old_rows.latest_snapshot_id IS DISTINCT FROM new_rows.latest_snapshot_id'
    END;
    -- An edit of either referenced snapshot must serialize with this
    -- comparison. FOR KEY SHARE from the foreign key alone permits tag edits.
    -- A missing prior snapshot may signify an active snapshot deleted by FK.
    EXECUTE format('WITH changes AS MATERIALIZED (%2$s), locked_snapshots AS MATERIALIZED (
      SELECT s.id, %1$I.artist_profile_facet_tags(s.normalized_data->''tags'') AS tags
      FROM %1$I.artist_provider_snapshot s
      JOIN (SELECT prior_id AS id FROM changes UNION SELECT next_id FROM changes) wanted USING (id)
      ORDER BY s.id FOR SHARE OF s
    )
    SELECT EXISTS (
      SELECT 1 FROM changes
      LEFT JOIN locked_snapshots prior ON prior.id = changes.prior_id
      LEFT JOIN locked_snapshots next ON next.id = changes.next_id
      WHERE (changes.prior_id IS NOT NULL AND prior.id IS NULL)
        OR (changes.next_id IS NOT NULL AND next.id IS NULL)
        OR coalesce(prior.tags, ''[]''::jsonb) IS DISTINCT FROM coalesce(next.tags, ''[]''::jsonb)
    )', TG_TABLE_SCHEMA, from_rows) INTO changed;
    IF NOT changed THEN
      RETURN NULL;
    END IF;
  ELSIF TG_TABLE_NAME = 'artist_provider_snapshot' AND TG_OP = 'UPDATE' THEN
    -- Do not gate writes on mutable current state or credits. A concurrent
    -- write could publish this snapshot or attach its artist to a track.
    EXECUTE format('SELECT EXISTS (
      SELECT 1 FROM old_rows FULL JOIN new_rows USING (id)
      WHERE %1$I.artist_profile_facet_tags(old_rows.normalized_data->''tags'')
        IS DISTINCT FROM %1$I.artist_profile_facet_tags(new_rows.normalized_data->''tags'')
    )', TG_TABLE_SCHEMA) INTO changed;
    IF NOT changed THEN
      RETURN NULL;
    END IF;
  ELSIF TG_NARGS > 1 THEN
    IF TG_OP = 'UPDATE' THEN
      SELECT string_agg(format('%I', field), ', ')
        INTO key_columns FROM unnest(string_to_array(TG_ARGV[1], ',')) AS field;
      from_rows := format('old_rows FULL JOIN new_rows USING (%s)', key_columns);
      -- Track visibility reads legacyHidden. The vocabulary additionally
      -- counts the presence of spotifyTrackSearch as a source.
      SELECT string_agg(CASE WHEN TG_TABLE_NAME = 'media_item' AND field = 'metadata' THEN
        '(old_rows.metadata->>''legacyHidden'' IS NOT DISTINCT FROM ''true'')
          IS DISTINCT FROM (new_rows.metadata->>''legacyHidden'' IS NOT DISTINCT FROM ''true'')'
        || CASE WHEN TG_ARGV[0] = 'album_facet_dirty' THEN
          ' OR (old_rows.metadata->''browse'') IS DISTINCT FROM (new_rows.metadata->''browse'')'
          WHEN TG_ARGV[0] = 'track_facet_dirty' THEN
          ' OR coalesce(old_rows.metadata ? ''spotifyTrackSearch'', false)
            IS DISTINCT FROM coalesce(new_rows.metadata ? ''spotifyTrackSearch'', false)'
          ELSE '' END
        ELSE format('old_rows.%1$I IS DISTINCT FROM new_rows.%1$I', field) END, ' OR ')
        INTO differences FROM unnest(string_to_array(TG_ARGV[2], ',')) AS field;
    ELSIF TG_OP = 'INSERT' THEN
      from_rows := 'new_rows';
    ELSE
      from_rows := 'old_rows';
    END IF;

    IF TG_TABLE_NAME = 'media_item' AND TG_ARGV[0] = 'album_facet_dirty' THEN
      relevant := CASE TG_OP
        WHEN 'UPDATE' THEN '(old_rows.media_type = ''album'' OR new_rows.media_type = ''album'')'
        WHEN 'INSERT' THEN 'new_rows.media_type = ''album'''
        ELSE 'old_rows.media_type = ''album'''
      END;
    ELSIF TG_TABLE_NAME = 'media_item' THEN
      relevant := CASE TG_OP
        WHEN 'UPDATE' THEN '(old_rows.media_type = ''track'' OR new_rows.media_type = ''track'')'
        WHEN 'INSERT' THEN 'new_rows.media_type = ''track'''
        ELSE 'old_rows.media_type = ''track'''
      END;
      -- Release lookups and retained Last.fm peer matching follow extension
      -- rows by ID, even if an existing media item's type is inconsistent.
      media_id := CASE TG_OP
        WHEN 'UPDATE' THEN 'coalesce(old_rows.id, new_rows.id)'
        WHEN 'INSERT' THEN 'new_rows.id'
        ELSE 'old_rows.id'
      END;
      relevant := format('(%s OR EXISTS (SELECT 1 FROM %I.album WHERE media_item_id = %s)
        OR EXISTS (SELECT 1 FROM %I.library_track WHERE media_item_id = %s))',
        relevant, TG_TABLE_SCHEMA, media_id, TG_TABLE_SCHEMA, media_id);
    ELSIF TG_TABLE_NAME = 'media_credit' AND TG_ARGV[0] <> 'album_facet_dirty' THEN
      relevant := CASE TG_OP
        WHEN 'UPDATE' THEN 'coalesce(old_rows.role, new_rows.role) = ''artist'''
        WHEN 'INSERT' THEN 'new_rows.role = ''artist'''
        ELSE 'old_rows.role = ''artist'''
      END;
    ELSIF TG_TABLE_NAME = 'media_item_tag' THEN
      tag_id := CASE TG_OP
        WHEN 'UPDATE' THEN 'coalesce(old_rows.tag_id, new_rows.tag_id)'
        WHEN 'INSERT' THEN 'new_rows.tag_id'
        ELSE 'old_rows.tag_id'
      END;
      -- A cascading tag delete may have already removed the tag. Mark that
      -- case conservatively because the missing tag could have been an album tag.
      relevant := format('NOT EXISTS (SELECT 1 FROM %I.tag
        WHERE tag.id = %s AND tag.media_type = ''film'')', TG_TABLE_SCHEMA, tag_id);
    ELSIF TG_TABLE_NAME = 'provider_reference' AND TG_ARGV[0] = 'track_facet_dirty' THEN
      -- The vocabulary holds the providers of tracks only. A track removed
      -- with its references is marked by its own row.
      media_id := CASE TG_OP
        WHEN 'UPDATE' THEN '(old_rows.media_item_id, new_rows.media_item_id)'
        WHEN 'INSERT' THEN '(new_rows.media_item_id)'
        ELSE '(old_rows.media_item_id)'
      END;
      relevant := format('EXISTS (SELECT 1 FROM %I.library_track WHERE media_item_id IN %s)',
        TG_TABLE_SCHEMA, media_id);
    END IF;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE (%s) AND %s)',
      from_rows, differences, relevant) INTO changed;
    IF NOT changed THEN
      RETURN NULL;
    END IF;
  END IF;

  writer := txid_current();
  EXECUTE format('INSERT INTO %s (transaction_id) VALUES ($1) ON CONFLICT DO NOTHING', markers)
    USING writer;
  GET DIAGNOSTICS writes = ROW_COUNT;
  IF writes > 0 THEN
    EXECUTE format('DELETE FROM %1$s WHERE transaction_id IN (
      SELECT transaction_id FROM %1$s WHERE transaction_id <> $1
      ORDER BY transaction_id LIMIT 8 FOR UPDATE SKIP LOCKED
    )', markers) USING writer;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
-- Observe the columns used by Album suggestion counts and labels. A history
-- snapshot can contribute only through its current-state row.
DO $$
DECLARE
  source record;
  trigger_name text;
BEGIN
  FOR source IN
    SELECT * FROM (VALUES
      ('media_item', 'id', 'id,media_type,title,summary,source_label,metadata'),
      ('album', 'media_item_id', 'media_item_id,edition_of_id'),
      ('library_track', 'media_item_id', 'media_item_id,album_media_item_id'),
      ('track', 'id', 'id,track_media_item_id,album_media_item_id'),
      ('playlist', 'id', 'id,name,kind'),
      ('playlist_item', 'playlist_id,media_item_id', 'playlist_id,media_item_id'),
      ('media_credit', 'media_item_id,artist_id,role', 'media_item_id,artist_id,role'),
      ('artist', 'id', 'id,name'),
      ('artist_provider_current_state', 'artist_id,provider', 'artist_id,provider,latest_snapshot_id'),
      ('artist_provider_snapshot', 'id', 'id,normalized_data'),
      ('media_item_tag', 'media_item_id,tag_id', 'media_item_id,tag_id'),
      ('tag', 'id', 'id,media_type,name,hidden'),
      ('tag_identity', 'media_type,normalized_name,kind', 'media_type,normalized_name,kind,tag_id'),
      ('tag_alias', 'source_tag_id', 'source_tag_id,target_tag_id'),
      ('tag_ancestor', 'media_type,descendant_key,ancestor_key', 'media_type,descendant_key,ancestor_key'),
      ('provider_reference', 'id', 'id,media_item_id,provider,reference_type,external_id'),
      ('film', 'media_item_id', 'media_item_id,source_kind,watched')
    ) AS sources(table_name, key_columns, compared_columns)
  LOOP
    trigger_name := 'album_facet_' || source.table_name;
    EXECUTE format(
      'CREATE TRIGGER %I AFTER TRUNCATE ON %I
       FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(''album_facet_dirty'')',
      trigger_name, source.table_name);
    IF source.table_name <> 'artist_provider_snapshot' THEN
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
         FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(''album_facet_dirty'', %L, %L)',
        trigger_name || '_insert', source.table_name, source.key_columns, source.compared_columns);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
         FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(''album_facet_dirty'', %L, %L)',
        trigger_name || '_delete', source.table_name, source.key_columns, source.compared_columns);
    END IF;
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
       FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(''album_facet_dirty'', %L, %L)',
      trigger_name || '_update', source.table_name, source.key_columns, source.compared_columns);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'media_runtime') THEN
    GRANT SELECT, UPDATE, DELETE ON album_facet_dirty TO media_runtime;
    GRANT SELECT, INSERT, UPDATE ON album_facet_state TO media_runtime;
    GRANT SELECT, INSERT, DELETE ON album_facet_value TO media_runtime;
  END IF;
END;
$$;
