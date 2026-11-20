-- Keep the original transaction marker protocol. For high-volume source
-- writes, inspect the rows affected by the statement before marking dirty.
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
  IF TG_ARGV[0] IS NULL OR TG_ARGV[0] NOT IN ('track_facet_dirty', 'recording_browse_order_dirty') THEN
    RAISE EXCEPTION 'Unexpected Browse cache marker table';
  END IF;
  markers := format('%I.%I', TG_TABLE_SCHEMA, TG_ARGV[0]);

  IF TG_NARGS > 1 THEN
    IF TG_OP = 'UPDATE' THEN
      SELECT string_agg(format('%I', field), ', ')
        INTO key_columns FROM unnest(string_to_array(TG_ARGV[1], ',')) AS field;
      from_rows := format('old_rows FULL JOIN new_rows USING (%s)', key_columns);
      -- Track visibility reads legacyHidden. The vocabulary additionally
      -- counts the presence of spotifyTrackSearch as a source.
      SELECT string_agg(CASE WHEN TG_TABLE_NAME = 'media_item' AND field = 'metadata' THEN
        '(old_rows.metadata->>''legacyHidden'' IS NOT DISTINCT FROM ''true'')
          IS DISTINCT FROM (new_rows.metadata->>''legacyHidden'' IS NOT DISTINCT FROM ''true'')'
        || CASE WHEN TG_ARGV[0] = 'track_facet_dirty' THEN
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

    IF TG_TABLE_NAME = 'media_item' THEN
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
    ELSIF TG_TABLE_NAME = 'media_credit' THEN
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
-- The projected fields include the primary key, so a changed key also
-- compares as a removed row plus an added row. TRUNCATE has no row images.
DO $$
DECLARE
  source record;
BEGIN
  FOR source IN
    SELECT * FROM (VALUES
      ('media_item', 'track_facet_media_item', 'track_facet_dirty',
        'id', 'id,media_type,title,source_label,metadata'),
      ('media_item', 'recording_browse_order_media_item', 'recording_browse_order_dirty',
        'id', 'id,media_type,title,release_date,source_label,metadata'),
      ('library_track', 'track_facet_library_track', 'track_facet_dirty',
        'media_item_id', 'media_item_id,album_media_item_id,album_name,spotify_track_id'),
      ('library_track', 'recording_browse_order_library_track', 'recording_browse_order_dirty',
        'media_item_id', 'media_item_id,spotify_track_id,isrc,duration_sec,date_added,album_name,spotify_album_id,album_media_item_id,scrobble_count,last_listened_at'),
      ('playlist_item', 'track_facet_playlist_item', 'track_facet_dirty',
        'playlist_id,media_item_id', 'playlist_id,media_item_id'),
      ('playlist_item', 'recording_browse_order_playlist_item', 'recording_browse_order_dirty',
        'playlist_id,media_item_id', 'playlist_id,media_item_id'),
      ('lastfm_track_link', 'track_facet_lastfm_track_link', 'track_facet_dirty',
        'username,artist_key,track_key,track_media_item_id', 'username,artist_key,track_key,track_media_item_id,strategy'),
      ('lastfm_track_link', 'recording_browse_order_track_link', 'recording_browse_order_dirty',
        'username,artist_key,track_key,track_media_item_id', 'username,artist_key,track_key,track_media_item_id,strategy'),
      ('lastfm_track_source', 'track_facet_lastfm_track_source', 'track_facet_dirty',
        'username,artist_key,track_key', 'username,artist_key,track_key,track_media_item_id,manually_matched'),
      ('lastfm_track_source', 'recording_browse_order_track_source', 'recording_browse_order_dirty',
        'username,artist_key,track_key', 'username,artist_key,track_key,track_media_item_id,manually_matched'),
      ('media_credit', 'track_facet_media_credit', 'track_facet_dirty',
        'media_item_id,artist_id,role', 'media_item_id,artist_id,role'),
      ('media_credit', 'recording_browse_order_media_credit', 'recording_browse_order_dirty',
        'media_item_id,artist_id,role', 'media_item_id,artist_id,role,billing_order'),
      ('media_item_tag', 'track_facet_media_item_tag', 'track_facet_dirty',
        'media_item_id,tag_id', 'media_item_id,tag_id')
    ) AS sources(table_name, trigger_name, marker_table, key_columns, compared_columns)
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', source.trigger_name, source.table_name);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L)',
      source.trigger_name, source.table_name, source.marker_table);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_insert', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_update', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty(%L, %L, %L)',
      source.trigger_name || '_delete', source.table_name,
      source.marker_table, source.key_columns, source.compared_columns);
  END LOOP;
END;
$$;

--> statement-breakpoint
-- Cascading film deletes can invoke these statement triggers even when their
-- transition tables are empty. Keep the original triggers for other events.
CREATE OR REPLACE TRIGGER track_facet_album
AFTER INSERT OR UPDATE OF media_item_id OR TRUNCATE ON album
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty');
--> statement-breakpoint
CREATE TRIGGER track_facet_album_delete
AFTER DELETE ON album REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('track_facet_dirty', 'rows');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER recording_browse_order_album
AFTER UPDATE OF media_item_id OR TRUNCATE ON album
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty');
--> statement-breakpoint
CREATE TRIGGER recording_browse_order_album_delete
AFTER DELETE ON album REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION mark_browse_cache_dirty('recording_browse_order_dirty', 'rows');
